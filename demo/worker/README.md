# Demo Worker

The public API behind the live demo on offhook.welldun.ai (see [DEMO.md](../../DEMO.md)). It runs on Cloudflare Workers' free plan.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /use-cases` | Site | The three launch use cases, from `site/src/use-cases.ts` |
| `GET /status` | Site | `{online, busy, paused}`: can a call start right now? |
| `POST /plans` | Site | `{purpose, turnstile_token}` → a plan or a refusal. 10 per visitor per day |
| `POST /sessions` | Site | `{use_case}` or `{plan}`, plus `turnstile_token` → `{session_id, ticket, voice_url, …}`. 3 per visitor per day |
| `GET /sessions/{id}` | Site | Status, transcript, what was written down, per-turn latency. Kept 24 hours |
| `POST /waitlist` | Site | `{email, company?, use_case?, turnstile_token}` |
| `POST /internal/claim` | Voice server | `{ticket}` → the session's plan, exactly once. HMAC-signed |
| `POST /internal/results` | Voice server | What happened on the call; frees the line. HMAC-signed |

All limits live in one Durable Object, the Gate (`src/gate.ts`), so they can't race: each visitor's daily plans, calls and signups (keyed on hashed IP and cookie, whichever runs out first), calls at once site-wide, and the day's talk-time cap. A line that isn't claimed within a minute is freed and the visitor's call given back. An hourly cron deletes sessions after 24 hours.

## Run it

Wrangler and the tests need Node 22 (`nvm use`).

```bash
pnpm install
cp .dev.vars.example .dev.vars   # add GROQ_API_KEY; the rest work as-is
npx wrangler d1 migrations apply offhook-demo --local
pnpm dev                         # http://localhost:8787
pnpm test
```

```bash
curl -s localhost:8787/plans -H 'content-type: application/json' \
  -d '{"purpose": "Call customers who missed a delivery yesterday. Find a new day and note any instructions for the driver."}'
```
