"""``python -m app.demo.reset_limits``: clear today's per-visitor demo limits.

For the maintainer (testing the live demo more than 3 times a day). Signs the
request with DEMO_HMAC_SECRET from .env; lines in use and the day's minute cap
are left alone.
"""

import json

import httpx

from app.demo.config import DemoSettings
from app.demo.signing import sign_request

if __name__ == "__main__":
    settings = DemoSettings()
    url = settings.worker_url.rstrip("/")
    if "localhost" in url:
        url = "https://demo.offhook.welldun.ai"  # WORKER_URL in .env points at local dev
    body = "{}"
    res = httpx.post(f"{url}/internal/reset", content=body, headers={"content-type": "application/json", **sign_request(settings.hmac_secret, body)})
    print(res.status_code, json.dumps(res.json()))
