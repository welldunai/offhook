# Running the live demo

The website's live demo has two parts (design in [DEMO.md](../DEMO.md)):

| Part | Code | Runs on |
| --- | --- | --- |
| **Worker**: plans, sessions, limits, waitlist | [`demo/worker`](worker) | Cloudflare Workers (free plan) |
| **Voice server**: runs the calls on Offhook's pipeline | [`app/demo`](../app/demo) | Your machine, in Docker, reachable only through a Cloudflare Tunnel |

## 1. Settings

In `.env` at the repo root (gitignored), set the voice server's keys:

```bash
DEEPGRAM_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
GROQ_API_KEY=...
DEMO_HMAC_SECRET=...        # any long random string; the Worker gets the same one
```

In `demo/worker/.dev.vars` (gitignored), set the Worker's: copy `.dev.vars.example`, add `GROQ_API_KEY`, and use the same `DEMO_HMAC_SECRET`.

## 2. Run it locally

```bash
# Worker (Node 22)
cd demo/worker && nvm use && pnpm install
npx wrangler d1 migrations apply offhook-demo --local
pnpm dev -- --port 8790

# Voice server, from the repo root
docker compose -f docker-compose.demo.yml up -d --build
curl localhost:8765/healthz          # {"ok":true,...}; 503 names any missing setting
curl localhost:8790/status           # {"online":true,...} within 30 seconds
```

Without Docker: `uv pip install -e . && WORKER_URL=http://localhost:8790 python -m app.demo`.

## 3. Put it online (milestone 4)

1. In the Cloudflare dashboard, create a tunnel. Give it the public hostname `voice.offhook.welldun.ai` → `http://voice:8765`.
2. Put its token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, and set `DEMO_WORKER_URL=https://demo.offhook.welldun.ai`.
3. `docker compose -f docker-compose.demo.yml --profile tunnel up -d`.
4. Deploy the Worker with `VOICE_URL=https://voice.offhook.welldun.ai` and the same secrets.

Both containers restart on their own after a crash or a reboot. Keep the Mac awake while the demo should be up (`caffeinate -s`, or Energy settings); when it sleeps, the site says the live demo is offline and still shows the sample calls.

## Useful checks

```bash
docker compose -f docker-compose.demo.yml ps         # "healthy"
docker compose -f docker-compose.demo.yml logs -f voice
npx wrangler d1 execute offhook-demo --local --command "SELECT status, end_reason FROM demo_sessions ORDER BY created_at DESC LIMIT 5"
```
