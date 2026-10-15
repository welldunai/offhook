# Running offhook (local runbook)

How to bring the whole stack up locally and place a working call — written so
either a human or an agent (Claude Code) can execute it top to bottom. Covers
the three core processes (API, worker, dashboard), the telephony tunnel, health
gates, and the recovery playbooks for the failures that actually bite. For
architecture/API reference see `README.md` and `ARCHITECTURE.md`.

Repo root: `<repo root>`. Always `source
.venv/bin/activate` first. Session convention: each process logs to a
`scratch_*.log` file in the repo root. Every command here is safe to re-run.

## Components & ports

| Process     | Command                  | Port | Needed for                                  |
| ----------- | ------------------------ | ---- | ------------------------------------------- |
| API         | `python run.py`          | 8000 | everything; browser playground at `/`       |
| Worker      | `python -m app.worker`   | —    | outbound/inbound calls (drains dial queue)  |
| Dashboard   | `npm run dev` (dashboard)| 5273 | Offhook Console UI (Clerk sign-in)          |
| ngrok       | `ngrok http 8000`        | 4040 | **real telephony only** (carrier webhooks)  |

The **API and worker are independent processes that both read `.env` at
startup.** If you change `.env`, restart *both*. The browser playground does
**not** need ngrok — it uses a local WebRTC transport.

## Step 0 — preflight: check what's already running

Don't double-start. See what's live before touching anything.

```bash
cd <repo root>
curl -s -m5 localhost:8000/readyz; echo                     # API health
pgrep -fl "run.py|app.worker|ngrok|vite" | grep -v grep     # live procs
lsof -ti:8000                                               # who owns :8000
pg_isready                                                  # Postgres up?
```

- `readyz` → `{"status":"ready", ...}` means the API is already up — don't start
  a second one.
- **Two `run.py` PIDs?** Only one owns `:8000` (`lsof -ti:8000`); the other is a
  stale leftover from a prior session — `kill <pid>` (then `kill -9` if it lingers).
- Postgres here is a **brew instance on :5432** (docker daemon is down), role + db
  both named `voice`. If `pg_isready` fails: `brew services start postgresql@14`.

## Step 1 — start the core (API + worker + dashboard)

Start only what Step 0 showed as *not* running. Backgrounded + logged.

```bash
source .venv/bin/activate

# 1. API (serves :8000, playground at /, health at /healthz, /readyz)
lsof -ti:8000 | xargs kill 2>/dev/null; sleep 2
nohup python run.py > scratch_api.log 2>&1 &

# 2. Worker — SEPARATE process; dials calls + delivers webhooks. Required for
#    any outbound/inbound call to progress past "queued". Restart it whenever
#    .env changes (it dials with .env's PUBLIC_BASE_URL).
pkill -f "app.worker" 2>/dev/null; sleep 1
nohup python -m app.worker > scratch_worker.log 2>&1 &

# 3. Dashboard (Offhook Console, Vite dev server on :5273)
cd dashboard && nohup npm run dev > ../scratch_dashboard.log 2>&1 & cd ..
```

Gate on health before continuing (poll, don't assume):

```bash
for i in $(seq 1 15); do R=$(curl -s -m3 localhost:8000/readyz); [ -n "$R" ] && { echo "$R"; break; }; sleep 1; done
tail -n5 scratch_worker.log                                 # expect "[worker] started"
curl -s -o /dev/null -w "%{http_code}\n" localhost:5273     # expect 200
```

At this point the **browser playground works**: http://localhost:8000/ (mic
call against seeded `DEV_AGENT_ID`). Dashboard: http://localhost:5273/ (Clerk
sign-in). No tunnel needed for either.

## Step 2 — telephony tunnel (ONLY for real phone calls)

Skip unless placing/receiving actual PSTN calls. **Free ngrok URLs change on
every restart** — this is the #1 recurring failure (Playbook A).

```bash
pkill -f ngrok 2>/dev/null; sleep 1
nohup ngrok http 8000 > scratch_ngrok.log 2>&1 &

# Get the fresh public URL
for i in $(seq 1 15); do
  URL=$(curl -s localhost:4040/api/tunnels | python3 -c "import sys,json;print(json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null)
  [ -n "$URL" ] && break; sleep 1
done; echo "$URL"

# Write it into .env
python3 - "$URL" <<'PY'
import re, sys
p=".env"; s=open(p).read()
s=re.sub(r'^PUBLIC_BASE_URL=.*$', f'PUBLIC_BASE_URL={sys.argv[1]}', s, flags=re.M)
open(p,"w").write(s); print("set PUBLIC_BASE_URL=", sys.argv[1])
PY

# Verify the tunnel reaches the app, THEN restart BOTH api+worker to pick up the URL
curl -s -m8 "$URL/readyz"; echo
pkill -f "app.worker"; sleep 1; nohup python -m app.worker > scratch_worker.log 2>&1 &
lsof -ti:8000 | xargs kill; sleep 2; nohup python run.py > scratch_api.log 2>&1 &
```

Why restart both: the **worker** builds the answer URL it hands the carrier at
dial time (`worker.py` reads `settings.public_base_url`); the **API** serves the
webhook. A stale URL in either → the carrier plays *"application error"* and the
call stalls at `dialing`.

> Free ngrok URLs change on every restart. For stability use a **reserved
> domain**: `ngrok http 8000 --domain=<your-reserved-domain>` so `.env` never
> changes. Offer this if the user keeps hitting stale-tunnel failures.

Point your Plivo number's answer URL at
`https://<PUBLIC_BASE_URL>/v1/telephony/inbound` for inbound calls.

## Step 3 — verify end to end

```bash
curl -s localhost:8000/healthz; echo                        # liveness
curl -s localhost:8000/readyz;  echo                        # db + migrations + master key
curl -s -m8 "$PUBLIC_BASE_URL/readyz"; echo                 # tunnel reaches app (telephony)
psql voice -c "select left(id::text,8) id,status,error_code,created_at::timestamp(0) \
  from calls order by created_at desc limit 5;"
```

A call that just **completed** confirms the pipeline end to end. Inspect one:

```bash
psql voice -c "select ts,type,error_code from call_events where call_id='<id>' order by ts;"
```

## How credentials work (important)

BYO/multi-tenant: **provider keys are NOT read from env at call time.** They're
stored **encrypted per-tenant in the DB** (`connections` table) and decrypted
only for the duration of a call.

- `CARTESIA_API_KEY`, `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, `PLIVO_*` in `.env` are
  consumed **only** by `python -m app.admin seed-dev` to bootstrap the first
  tenant's connections. The API server and worker never read them.
- After seeding, manage credentials via the API (`POST/PATCH /v1/connections`)
  or the dashboard. Deleting the provider keys from `.env` does **not** affect a
  running stack.
- The **Cartesia voice id lives in the Cartesia connection credential** (its
  secrets), not in env and not hardcoded. Override per call via the agent
  payload; otherwise it comes from the connection.

## One-time setup (fresh machine only)

Skip on this machine — it's already set up (venv at `.venv` Python 3.13, brew
Postgres with role+db `voice`, populated `.env`, migrations at head, ngrok
installed with an authtoken, dashboard `node_modules` + `dashboard/.env`).

```bash
uv venv && source .venv/bin/activate
uv pip install -e .
cp .env.example .env

# Postgres: brew instance, then create role+db 'voice' (or `docker compose up -d`)
createuser voice 2>/dev/null; createdb -O voice voice 2>/dev/null

# Master key (base64, 32 bytes) → put in .env as MASTER_ENCRYPTION_KEY
python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"

alembic upgrade head                      # migrations (separate from app boot)

# Seed the first tenant + connections (from env keys) + a demo agent.
python -m app.admin seed-dev --voice-id <cartesia-voice-id>
#  → prints an API key (ONCE) and an agent id. Put the agent id in .env:
#    DEV_AGENT_ID=<agent-id>
```

---

# Playbooks — the failures seen in practice

## Playbook A — calls stuck at `dialing` / "connection failing"

Classic symptom: a new outbound call never leaves `dialing`; the caller hears
*"application error"*; no webhook hit in the API log. Cause is almost always
**`PUBLIC_BASE_URL` pointing at a dead/old ngrok tunnel** (or ngrok not running).

Diagnose:

```bash
grep PUBLIC_BASE_URL .env
pgrep -f ngrok >/dev/null && echo "ngrok up" || echo "ngrok DOWN"
```

Fix = **Step 2** (start ngrok, update `.env`, restart *both* api+worker).

Note: calls already handed to the carrier with the dead URL **won't self-heal** —
mark them failed (Playbook B) and place a fresh call to test.

## Playbook B — mark stuck calls as failed

Never raw-`UPDATE` the `calls` table — that skips the event timeline and the
webhooks, so `/events` and the tenant's webhooks drift from reality. Use the
app's `emit_call_event` so both stay consistent. Adjust the WHERE / IDs.

```bash
source .venv/bin/activate
python - <<'PY'
import asyncio, uuid
from sqlalchemy import select
from app.db.engine import session_scope
from app.db.models import Call
from app.events import emit_call_event

MSG = "stale PUBLIC_BASE_URL: carrier could not reach answer webhook (tunnel down)"
CODE = "config_error"   # stable code; see README error-code list

async def main():
    async with session_scope() as db:
        # target every call stuck mid-flight; narrow by date/id if needed
        rows = (await db.execute(
            select(Call).where(Call.status.in_(["dialing","queued","reserved"]))
        )).scalars().all()
        for call in rows:
            call.status = "failed"; call.error = MSG; call.error_code = CODE
            await emit_call_event(db, call.tenant_id, call.id, "call.failed",
                                  {"status": "failed", "error": MSG}, error_code=CODE)
            print(f"{str(call.id)[:8]} -> failed ({CODE})")
asyncio.run(main())
PY
```

Verify: the `calls` row shows `failed`, and `call_events` has a matching
`call.failed` row:

```bash
psql voice -c "select left(call_id::text,8) call,type,error_code from call_events \
  where type='call.failed' order by ts desc limit 5;"
```

## Troubleshooting matrix

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Call stuck at `dialing`, "application error", no webhook in API log | `PUBLIC_BASE_URL` → dead/old ngrok tunnel | Playbook A (Step 2): start ngrok, update `.env`, restart **API *and* worker** |
| Fixed `.env` but call still fails the same way | Restarted API but **not the worker** (dials with stale URL) | `pkill -f app.worker; python -m app.worker &` |
| **Overview / Usage look empty** but calls exist | `/v1/stats`, `/v1/usage`, `count_calls_this_month` filter to `date_trunc('month', now())` — the *current calendar month*. At a month boundary (July now, calls in June) every stat reads 0 | Not a bug — data returns as calls land this month. The Overview "Recent calls" table is *not* month-scoped and still lists them. To see history, add/use a `from`/`to` range on `/v1/stats` |
| Call connects but **agent is silent**; transcript has text | TTS auth failing — look for `CartesiaTTSService ... HTTP 401` in API log | The Cartesia key in that agent's TTS **connection** is invalid. Update via `PATCH /v1/connections/<id>` |
| Agent uses the wrong/unexpected voice | voice_id resolves from the **connection credential** (or per-call override), not env | Set the voice on the right Cartesia connection; agent must point at that connection |
| `python run.py` exits / port in use | Old API still bound to `:8000` | `lsof -ti:8000 \| xargs kill` then restart |
| Worker log quiet, calls never leave `queued` | Worker not running | Start `python -m app.worker` |
| Provider keys in `.env` seem ignored | They're **only** for `app.admin seed-dev` — API/worker decrypt per-tenant creds from the DB | Manage creds via `/v1/connections` or the dashboard, not `.env` |

To find the agent/connection a call used, check the runner log line
(`[voice] ... agent=<name>`) and:

```bash
psql voice -c "select id,name,tts_connection_id from agents;"
psql voice -c "select id,name,provider_kind,provider_name from connections;"
```

## Restart / stop

```bash
# Restart API (e.g. after a .env change)
lsof -ti:8000 | xargs kill; nohup python run.py > scratch_api.log 2>&1 &

# Restart worker (do this whenever you change .env that affects dialing)
pkill -f "app.worker"; nohup python -m app.worker > scratch_worker.log 2>&1 &

# Stop everything
lsof -ti:8000 | xargs kill 2>/dev/null      # API
pkill -f "app.worker" 2>/dev/null            # worker
lsof -ti:5273 | xargs kill 2>/dev/null       # dashboard
pkill -f ngrok 2>/dev/null                   # tunnel
```

## Logs

Processes log to the `scratch_*.log` files above. Useful greps:

```bash
grep -iE "error|exception|401|application error|telephony" scratch_api.log
tail -f scratch_worker.log     # watch dials
```

Set `VOICE_DEBUG_LOGGING=1` in `.env` for per-stage TTFB (STT/LLM/TTS) timing,
also shown in the prebuilt UI's metrics panel.
