import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { testEnv } from "./env";

let env: Env;
beforeEach(() => {
  env = testEnv().env;
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.test${path}`, init), env);
const SITE = { origin: "https://offhook.welldun.ai" };
const VISITOR = { ...SITE, "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", cookie: "oh_vid=3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b" };
const post = (body: unknown, headers: Record<string, string> = VISITOR) =>
  call("/plans", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Stubs fetch: Turnstile answers `human`; Groq answers `groq` (a JSON string) or fails. */
function stubUpstreams({ human = true, groq }: { human?: boolean; groq?: string }) {
  const f = vi.fn(async (url: string) => {
    if (url.includes("turnstile")) return new Response(JSON.stringify({ success: human }));
    if (groq === undefined) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: groq } }] }));
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const REFUSAL = JSON.stringify({ status: "refused", reason: "Can't pose as a bank." });

describe("routing and CORS", () => {
  it("lists the launch use cases", async () => {
    const body: any = await (await call("/use-cases")).json();
    expect(body.use_cases.map((u: any) => u.slug)).toEqual(["recruiter-screening", "appointment-confirmation", "lead-qualification"]);
  });
  it("answers preflight for the site, with credentials for the visitor cookie", async () => {
    const res = await call("/plans", { method: "OPTIONS", headers: SITE });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://offhook.welldun.ai");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it("refuses other origins", async () => {
    expect((await call("/use-cases", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/plans")).status).toBe(405);
  });
});

describe("POST /plans", () => {
  it("rejects bad bodies before any upstream call", async () => {
    const f = stubUpstreams({ groq: REFUSAL });
    expect((await post("not json")).status).toBe(400);
    expect((await post({ purpose: "", turnstile_token: "x" })).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("needs a passing bot check before Groq", async () => {
    const f = stubUpstreams({ human: false, groq: REFUSAL });
    const res = await post({ purpose: "Call customers back", turnstile_token: "x" });
    expect(res.status).toBe(403);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://challenges.cloudflare.com/turnstile/v0/siteverify"]);
  });
  it("returns the result with plans left, then 429 at the daily limit", async () => {
    stubUpstreams({ groq: REFUSAL });
    const ok = { purpose: "Call people as their bank", turnstile_token: "x" };
    expect(await (await post(ok)).json()).toEqual({ status: "refused", reason: "Can't pose as a bank.", plans_left: 1 });
    expect(((await (await post(ok)).json()) as any).plans_left).toBe(0);
    const res = await post(ok);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as any).error).toBe("limit_reached");
  });
  it("gives the plan back when the planner fails", async () => {
    stubUpstreams({});
    const ok = { purpose: "Call customers back", turnstile_token: "x" };
    for (let i = 0; i < 3; i++) expect((await post(ok)).status).toBe(502);
    stubUpstreams({ groq: REFUSAL });
    expect(((await (await post(ok)).json()) as any).plans_left).toBe(1);
  });
  it("sets the visitor cookie for new visitors only", async () => {
    stubUpstreams({ groq: REFUSAL });
    const fresh = await post({ purpose: "Call people", turnstile_token: "x" }, { ...SITE, "content-type": "application/json" });
    expect(fresh.headers.get("set-cookie")).toMatch(/^oh_vid=/);
    expect((await post({ purpose: "Call people", turnstile_token: "x" })).headers.get("set-cookie")).toBeNull();
  });
});
