# Running Offhook locally

How to bring up the whole stack on your machine, place a working call, and fix the failures that come up most often. For first-time setup, follow the [README quickstart](README.md#quickstart-talk-to-an-agent-in-your-browser) first. For the API and internals, see [REFERENCE.md](REFERENCE.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Run every command from the repo root with the virtualenv active (`source .venv/bin/activate`). The commands are safe to re-run.

## Components and ports

| Process   | Command                       | Port | Needed for                                     |
| --------- | ----------------------------- | ---- | ---------------------------------------------- |
| API       | `python run.py`               | 8000 | Everything; browser playground at `/`          |
| Worker    | `python -m app.worker`        | —    | Phone calls (dials queued calls, sends webhooks) |
| Dashboard | `npm run dev` in `dashboard/` | 5273 | Offhook Console UI (needs Clerk, optional)     |
| Tunnel    | `ngrok http 8000`             | 4040 | Real phone calls only (carrier webhooks)       |

The API and the worker are separate processes and both read `.env` when they start. **If you change `.env`, restart both.** The browser playground does not need the worker or a tunnel; it uses a local WebRTC transport.

## 1. Check what is already running

```bash
curl -s -m5 localhost:8000/readyz; echo        # API health
pgrep -fl "run.py|app.worker|ngrok|vite"        # running processes
pg_isready                                      # Postgres
```

- `{"status":"ready", ...}` from `/readyz` means the API is already up.
- If port 8000 is taken by an old API process, stop it with `lsof -ti:8000 | xargs kill`.
- If Postgres is down, start it with `docker compose up -d` (or your local Postgres service).

## 2. Start the API, worker and dashboard

Start only what step 1 showed as not running. Each process logs to a `scratch_*.log` file, which git ignores.

```bash
nohup python run.py > scratch_api.log 2>&1 &
nohup python -m app.worker > scratch_worker.log 2>&1 &
(cd dashboard && nohup npm run dev > ../scratch_dashboard.log 2>&1 &)   # optional
```

Wait until the API is healthy:

```bash
for i in $(seq 1 15); do R=$(curl -s -m3 localhost:8000/readyz); [ -n "$R" ] && { echo "$R"; break; }; sleep 1; done
tail -n5 scratch_worker.log      # expect "[worker] started"
```

The browser playground is now at http://localhost:8000 and the dashboard at http://localhost:5273.

## 3. Open a tunnel (real phone calls only)

The carrier needs a public URL to reach your API. With ngrok:

```bash
nohup ngrok http 8000 > scratch_ngrok.log 2>&1 &
URL=$(curl -s localhost:4040/api/tunnels | python3 -c "import sys,json;print(json.load(sys.stdin)['tunnels'][0]['public_url'])")
echo "$URL"
```

Set `PUBLIC_BASE_URL=$URL` in `.env`, check that the tunnel reaches the app, then restart **both** the API and the worker:

```bash
curl -s -m8 "$URL/readyz"; echo
pkill -f app.worker; nohup python -m app.worker > scratch_worker.log 2>&1 &
lsof -ti:8000 | xargs kill; sleep 2; nohup python run.py > scratch_api.log 2>&1 &
```

Both need the new URL: the worker hands it to the carrier when it dials, and the API serves the webhook the carrier calls back. If either has a stale URL, the caller hears "application error" and the call stalls at `dialing`.

Free ngrok URLs change every time ngrok restarts. A reserved domain (`ngrok http 8000 --domain=<your-domain>`) keeps `.env` stable.

For inbound calls, point your number's answer URL at `https://<PUBLIC_BASE_URL>/v1/telephony/inbound`.

## 4. Check a call end to end

```bash
curl -s localhost:8000/healthz; echo     # liveness
curl -s localhost:8000/readyz;  echo     # database, migrations, master key
psql voice -c "select left(id::text,8) id, status, error_code, created_at::timestamp(0)
  from calls order by created_at desc limit 5;"
```

A call with status `completed` confirms the whole pipeline works. To see one call's timeline, use `GET /v1/calls/<id>/events`, or:

```bash
psql voice -c "select ts, type, error_code from call_events where call_id='<id>' order by ts;"
```

## How credentials work

Provider keys are **not** read from `.env` when a call runs. They are stored encrypted per tenant in the `connections` table and decrypted only for the length of a call.

- `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `GROQ_API_KEY` and `PLIVO_*` in `.env` are read only by `python -m app.admin seed-dev`, to create the first dev tenant's connections. The API and worker never read them.
- After seeding, manage keys with `POST/PATCH /v1/connections` or the dashboard.
- The Cartesia voice ID is stored on the Cartesia connection. An agent can override it per call.

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| Call stuck at `dialing`, caller hears "application error", no webhook in the API log | `PUBLIC_BASE_URL` points at a dead or old tunnel | Redo step 3 and restart the API **and** the worker |
| Fixed `.env` but the call fails the same way | Only the API was restarted; the worker still has the old URL | `pkill -f app.worker; nohup python -m app.worker > scratch_worker.log 2>&1 &` |
| Calls never leave `queued` | Worker isn't running | Start `python -m app.worker` |
| Call connects but the agent is silent, while the transcript has text | TTS auth failing (`CartesiaTTSService ... HTTP 401` in the API log) | Update the key on that agent's TTS connection with `PATCH /v1/connections/<id>` |
| Agent uses an unexpected voice | The voice comes from the Cartesia connection (or a per-call override), not `.env` | Set the voice on the connection the agent points at |
| Overview and Usage pages are empty although calls exist | `/v1/stats` and `/v1/usage` default to the current calendar month | Pass a `from`/`to` range; the "Recent calls" table is not month-limited |
| `python run.py` exits with "port in use" | An old API process still holds port 8000 | `lsof -ti:8000 \| xargs kill`, then restart |
| Provider keys in `.env` seem to be ignored | They are only used by `seed-dev` | Manage keys through `/v1/connections` or the dashboard |

To see which agent and connections a call used:

```bash
psql voice -c "select id, name, tts_connection_id from agents;"
psql voice -c "select id, name, provider_kind, provider_name from connections;"
```

### Mark stuck calls as failed

Calls that the carrier received with a dead URL do not recover on their own. Don't `UPDATE` the `calls` table directly: that skips the event timeline and the webhooks. Use `emit_call_event` so both stay in sync:

```bash
python - <<'PY'
import asyncio
from sqlalchemy import select
from app.db.engine import session_scope
from app.db.models import Call
from app.events import emit_call_event

MSG = "carrier could not reach the answer webhook"
CODE = "config_error"

async def main():
    async with session_scope() as db:
        rows = (await db.execute(
            select(Call).where(Call.status.in_(["dialing", "queued", "reserved"]))
        )).scalars().all()
        for call in rows:
            call.status = "failed"; call.error = MSG; call.error_code = CODE
            await emit_call_event(db, call.tenant_id, call.id, "call.failed",
                                  {"status": "failed", "error": MSG}, error_code=CODE)
            print(f"{str(call.id)[:8]} -> failed ({CODE})")
asyncio.run(main())
PY
```

Narrow the `where` clause by date or ID if you only want to fail some calls.

## Stop everything

```bash
lsof -ti:8000 | xargs kill 2>/dev/null     # API
pkill -f app.worker 2>/dev/null            # worker
lsof -ti:5273 | xargs kill 2>/dev/null     # dashboard
pkill -f ngrok 2>/dev/null                 # tunnel
```

Set `VOICE_DEBUG_LOGGING=1` in `.env` to log per-stage latency (STT, LLM, TTS). The playground's metrics panel shows the same numbers.
