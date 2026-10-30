# Offhook on Cloudflare (off the laptop)

Hosted Offhook and the website's live demo run in Docker on the maintainer's Mac
today, reached through a Cloudflare Tunnel. When the Mac sleeps, everything is
down (it was for nine hours on 2026-10-25). This moves them to Cloudflare
Containers on the Workers Paid plan, with the database on Neon's free Postgres.

## Decisions

- **Cloudflare Containers** (Workers Paid, $5/month). One container holds the API,
  the call worker and the demo voice server, so one instance is awake at a time.
  It sleeps when idle and costs nothing while asleep.
- **Neon** (free) for Postgres: container disks are wiped on every sleep, and
  Cloudflare has no managed Postgres. Free: 1 GB storage, 100 compute-hours a
  month, scales to zero after 5 minutes.
- **Budget:** $5/month includes 25 GiB-hours of memory and 375 vCPU-minutes. At the
  `standard-1` size (½ vCPU, 4 GiB) that is about 6 hours awake a month; each
  further hour is roughly $0.04 of memory plus up to $0.04 of CPU while busy.
  Cloudflare has no hard cap, so usage alerts go on.

## Shape

```
offhook.welldun.ai (site)        app.offhook.welldun.ai (dashboard)       Twilio / Plivo
        │                                   │                                 │
        ▼                                   ▼                                 ▼
demo.offhook.welldun.ai ──────────▶ api.offhook.welldun.ai  ──  Worker "offhook-api"
 (demo Worker, unchanged)            voice.offhook.welldun.ai        │  forwards every request,
                                                                     │  WebSockets included
                                                                     ▼
                                              Container "OffhookApp" (one instance, standard-1)
                                              uvicorn app.cloud:app
                                                ├─ the API (/v1/…)         ← app.main
                                                ├─ the call worker loop    ← app.worker, in-process
                                                └─ the demo voice server   ← app.demo, at /demo
                                                         │
                                                         ▼
                                              Neon Postgres (free)      R2 for recordings (later)
```

- **Sleeping:** the container sleeps 5 minutes after its last request, but never
  while a call is running. Before stopping, the Worker asks the app
  (`/_activity`, which only the Worker can reach) and keeps it awake if a call is in progress (WebSocket
  traffic alone isn't reliably counted as activity).
- **Waking:** any request wakes it (a cold start of a few seconds). The dashboard,
  the API, carrier webhooks and the demo all just work, a little slower on the
  first request after a quiet spell.
- **The call worker** runs inside the API process. While the container is awake
  it places queued calls and sends webhooks as today. Work that comes due while it
  sleeps (a webhook retry) waits until the next wake.

## Milestones

Each ends with a check before the next.

1. **One app, one container.** `app/cloud.py` serves the API, the worker loop and the
   demo together; the Worker wraps it in a Container. Deployed to a test address,
   `api-next.offhook.welldun.ai`, against Neon. Checks: health, cold start time, a
   dashboard test call, a demo call, and that a call keeps the container awake.
2. **Move the data and switch over.** Copy the hosted database to Neon, point
   `api.offhook.welldun.ai` and the demo at the new Worker, and watch the first day.
3. **Tidy up.** Recordings to R2, usage alerts, retire the Mac's containers and the tunnel.

## Deploying

Deploys run on GitHub Actions (`.github/workflows/deploy-cloud.yml`, started by hand):
native amd64 builds and a steady connection for the image upload. Deploying from the
Mac kept failing on dropped connections. Secrets are set with `wrangler secret bulk`
from `deploy/cloudflare` (values from `.env.neon`, `.env.hosted` and `.env`).

## Step 1 results (2026-10-30, on `api-next.offhook.welldun.ai`)

- First start after the deploy: 18.5 s (image fetch + migrations on Neon). Warm requests: ~0.7 s.
- Waking after idle: 23.2 s with migrations at boot; **7.5 s** once they moved to the
  deploy workflow (migrations run there, before `wrangler deploy`).
- Bots probing `/`, `/.env` and the like kept the container awake; the Worker now
  answers anything outside `/v1`, `/ws` and `/healthz` itself, so they don't wake it.
- Carriers wait about 15 s for an incoming-call webhook, so a cold wake fits; the
  Numbers page also tells users to set the same address as the fallback URL.
- `/_activity` is 404 from the internet; CORS allows only the dashboard; no sign-in → 401.
- A full test call through the Worker and container, on Neon, with Offhook's own
  providers: the agent rescheduled, recorded both answers and hung up with a summary.

## Needed from you

- **Workers Paid** on the Welldun account (dashboard → Workers & Pages → Plans).
- **A Neon project:** sign up at neon.com, create a project (region nearest the
  callers, e.g. AWS Asia Pacific (Mumbai) or Singapore), and keep its connection
  string for `wrangler secret put` (it never goes through chat).
