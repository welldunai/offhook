"""End-to-end check of the live demo in a real browser (Chromium, fake microphone).

Needs the three local servers from demo/README.md running:
  * the Worker:        cd demo/worker && pnpm dev -- --port 8790 --var DAILY_CALLS_PER_VISITOR:100 --var DAILY_PLANS_PER_VISITOR:100
  * the voice server:  python -m app.demo   (or docker compose -f docker-compose.demo.yml up -d)
  * the site:          cd site && pnpm dev --port 4321

Run from the repo root (uses CARTESIA_API_KEY and CARTESIA_VOICE_ID from .env to
synthesize the patient's lines once; they're cached in demo/e2e/.cache):

  pip install playwright && playwright install chromium
  python demo/e2e/browser_call.py

Exits non-zero on the first failed check.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
import wave
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

SITE = "http://localhost:4321"
CACHE = Path(__file__).parent / ".cache"
LINES = [
    "Oh, actually something came up on Tuesday. Could we do Wednesday afternoon instead?",
    "Two thirty on Wednesday works. Thanks!",
    "No, that's everything. Bye!",
]


def env() -> dict[str, str]:
    """Return .env at the repo root as a dict."""
    out = {}
    for line in Path(".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def patient_wav() -> Path:
    """Build (once) the fake microphone: each line after a pause long enough for the agent to talk.

    Returns:
        The path to a 16 kHz mono WAV file.
    """
    path = CACHE / "patient.wav"
    if path.exists():
        return path
    CACHE.mkdir(exist_ok=True)
    e = env()
    clips = []
    for text in LINES:
        req = urllib.request.Request(
            "https://api.cartesia.ai/tts/bytes",
            method="POST",
            headers={"X-API-Key": e["CARTESIA_API_KEY"], "Cartesia-Version": "2025-04-16", "content-type": "application/json"},
            data=json.dumps({
                "model_id": "sonic-3",
                "transcript": text,
                "voice": {"mode": "id", "id": e["CARTESIA_VOICE_ID"]},
                "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
            }).encode(),
        )
        clips.append(urllib.request.urlopen(req, timeout=30).read())
    silence = lambda s: b"\x00\x00" * int(16000 * s)  # noqa: E731
    pcm = silence(11) + clips[0] + silence(9) + clips[1] + silence(12) + clips[2] + silence(40)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    return path


def check(name: str, ok: bool, detail: str = "") -> None:
    """Print a check's result; stop on failure."""
    print(f"{'ok  ' if ok else 'FAIL'} {name}{f': {detail}' if detail else ''}")
    if not ok:
        sys.exit(1)


def example_call(page: Page) -> None:
    """The appointment example, end to end: brief, live call, results, waitlist."""
    page.goto(f"{SITE}/")
    page.click("[data-example=appointment-confirmation]")
    page.click("[data-plan=appointment-confirmation] [data-start]")
    expect(page.locator("[data-call-dialog]")).to_have_attribute("open", "")
    page.click("[data-go]")
    expect(page.locator("[data-slot=status-text]")).to_have_text("On the call", timeout=20_000)
    expect(page.locator("[data-slot=status-text]")).to_have_text("Call ended", timeout=90_000)
    bubbles = page.locator("[data-slot=bubbles] li")
    check("the agent and the patient both spoke", bubbles.count() >= 3, f"{bubbles.count()} turns")
    expect(page.locator("[data-slot=summary-box]")).to_be_visible(timeout=15_000)
    results = dict(
        (r.locator("span").inner_text(), r.locator("strong").inner_text())
        for r in page.locator("[data-slot=results] .wd-result").all()
    )
    check("the new time was written down", "wednesday" in results.get("New time", "").lower(), json.dumps(results))
    check("the call problem box stayed hidden", not page.is_visible("[data-slot=call-problem]"))
    page.fill("#wl-email", "e2e@example.com")
    page.click("[data-waitlist] button")
    expect(page.locator("[data-slot=waitlist-msg]")).to_contain_text("on the list", timeout=15_000)
    check("waitlist signup", True)


def custom_plan(page: Page) -> None:
    """Plan your own call, edit it, and open the call dialog with the edit applied."""
    page.goto(f"{SITE}/use-cases/")
    page.click("[data-idea]")
    page.click(".composer-go")
    card = page.locator("[data-plan=custom]")
    expect(card).to_be_visible(timeout=30_000)
    page.click("[data-edit]")
    page.fill("input[name=name]", "Robin")
    page.click(".plan-edit .plan-edit-row button:has-text('Add another')")
    page.locator(".plan-edit-list input").last.fill("Best time to deliver")
    page.click("text=Save the plan")
    expect(card.locator("[data-slot=agent]")).to_contain_text("Robin")
    check("edited plan shows the new field", "Best time to deliver" in card.locator("[data-slot=fields]").inner_text())
    card.locator("[data-start]").click()
    expect(page.locator("[data-slot=title]")).to_contain_text("Robin")
    page.click("[data-close]")


def use_case_page(page: Page) -> None:
    """'Try it live' on a use-case page opens the same call dialog."""
    page.goto(f"{SITE}/use-cases/recruiter-screening/")
    button = page.locator("[data-try]")
    expect(button).to_be_enabled(timeout=10_000)
    button.click()
    expect(page.locator("[data-slot=title]")).to_have_text("Talk to Sam from Northwind")
    page.click("[data-close]")


def main() -> None:
    """Run the checks in one browser."""
    wav = patient_wav()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={wav}",
        ])
        page = browser.new_context(permissions=["microphone"]).new_page()
        errors: list[str] = []
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        use_case_page(page)
        custom_plan(page)
        example_call(page)
        check("no console errors", not errors, "; ".join(errors[:3]))
        browser.close()


if __name__ == "__main__":
    main()
