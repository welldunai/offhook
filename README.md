# offhook

An open-source, self-hostable voice-calling backend any third party can consume (N8N,
Composio, plain API). Place voice calls driven by **STT + LLM + TTS**,
orchestrated by [Pipecat]. **Multi-tenant**: each tenant authenticates with an
API key and brings their own provider credentials (BYO keys), stored encrypted.

[Pipecat]: https://github.com/pipecat-ai/pipecat

## How it works (multi-tenant)

1. A **tenant** holds an **API key** (`Authorization: Bearer vk_...`).
2. The tenant registers **connections** — their provider keys (Deepgram,
   Cartesia, an LLM, Plivo), stored **encrypted** (envelope encryption; a
   per-tenant data key wrapped by a master key held outside the DB).
3. They define **agents** (instructions, voice, model) that reference those
   connections per leg.
4. `POST /v1/calls {agent_id, to_number, context}` places a call; credentials
   are decrypted only for the duration of that call, never logged or returned.

Security: API keys hashed with argon2id; secrets AES-GCM encrypted at rest
(AAD-bound to their row); per-tenant query scoping; carrier webhooks authed by a
single-use session token (+ Plivo signature); SSRF guard on outbound URLs; log
redaction. See `app/{auth,crypto,security,tenancy}`.

## Stack (same providers as rubik)

| Layer      | Default provider | Env var to swap            |
| ---------- | ---------------- | -------------------------- |
| STT        | Deepgram (`nova-3`) | `VOICE_STT_PROVIDER`    |
| TTS        | Cartesia (`sonic-3`) | `VOICE_TTS_PROVIDER`   |
| LLM        | Groq (`llama-3.1-8b-instant`) | `VOICE_LLM_PROVIDER` |
| Telephony  | Plivo            | `VOICE_TELEPHONY_PROVIDER` |
| Dev call   | SmallWebRTC (browser) | —                     |

LLM options: `groq` (fastest, free tier — the default), `gemini` (Google direct,
`gemini-2.5-flash`), `openrouter`, `openai`. TTS: `cartesia` (`sonic-3` is far
more expressive than `sonic-2`) or `openai`.

The pipeline is `transport.input() → STT → LLM (with tools) → TTS → transport.output()`.
Provider choice is fully env-driven (see `app/config.py`); per-call voice/model
overrides are supported via the `agent` payload.

## Setup

Requires **Postgres**. Local dev:

```bash
uv venv && source .venv/bin/activate
uv pip install -e .
cp .env.example .env

# Postgres (docker compose, or use a local instance + create role/db 'voice')
docker compose up -d

# Generate a master key, put it in .env as MASTER_ENCRYPTION_KEY (base64, 32 bytes):
python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"

alembic upgrade head                       # run migrations (separate from app boot)
python -m app.admin seed-dev               # tenant + connections (from env keys) + demo agent
python run.py                              # serves on :8000
```

`seed-dev` prints an **API key (once)** and a **DEV_AGENT_ID** — add the latter
to `.env` for the playground. The browser playground (`http://localhost:8000`,
dev only) talks to that agent using its stored connections.

Key env (see `.env.example`): `DATABASE_URL`, `MASTER_ENCRYPTION_KEY`,
`PUBLIC_BASE_URL` (required in prod for carrier callbacks), `ENV`,
`ENABLE_PREBUILT_UI` (must be off in prod). The master key lives outside the DB;
**lose it and the stored secrets are unrecoverable** — keep it in a secrets
manager, never commit it.

## API

All `/v1` routes require `Authorization: Bearer <api-key>`. Secrets are
write-only — they're never returned by any endpoint.

### 1. Register connections (BYO provider keys)

```bash
curl -X POST localhost:8000/v1/connections -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "name":"my-groq","provider_kind":"llm","provider_name":"groq",
  "secrets":{"api_key":"gsk_..."}
}'   # → {"id":"conn_...","name":"my-groq","provider_kind":"llm",...}  (no secret)
```

Provider must be in the supported list (`GET /v1/providers`): STT `deepgram`;
TTS `cartesia`/`openai`; LLM `groq`/`gemini`/`openrouter`/`openai`; telephony
`plivo`. Plivo secrets are `{auth_id, auth_token, from_number}`.

### 2. Define an agent

```bash
curl -X POST localhost:8000/v1/agents -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "name":"Alex","company":"Acme Clinic",
  "instructions":"Confirm the dental appointment; offer to reschedule if needed.",
  "first_message":"Hi, this is Alex from Acme Clinic. Am I speaking with Priya?",
  "stt_connection_id":"<id>","tts_connection_id":"<id>",
  "llm_connection_id":"<id>","telephony_connection_id":"<id>",
  "provider_settings":{"tts":{"voice_id":"...","model":"sonic-3","emotion":"warm"}}
}'
```

### 3. Place an outbound call

```bash
curl -X POST localhost:8000/v1/calls -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "agent_id":"<agent-id>",
  "to_number":"+919876543210",
  "context":{"patient_name":"Priya","appointment_time":"Tuesday at 3 PM","doctor":"Dr. Rao"}
}'   # → {"id":"call_...","status":"dialing","provider_call_id":"..."}
```

Everything in `context` is rendered into the agent's system prompt under a
"CALL CONTEXT" block, so the agent speaks with those facts in scope. Requires a
telephony connection and a publicly reachable `PUBLIC_BASE_URL` for the carrier
answer/stream webhooks (which are authed by a single-use call token).

`POST /v1/calls` returns immediately with `status: queued`; a **worker** dials
asynchronously and the call progresses through `queued → dialing → in_progress
→ completed/failed`. Poll `GET /v1/calls/{id}` or receive webhooks. Pass an
`Idempotency-Key` header so a retried request never double-dials.

### Webhooks

```bash
curl -X POST localhost:8000/v1/webhooks -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"url":"https://you.example.com/hook","events":[]}'
# → {"id":"...","secret":"whsec_…","...}   (secret shown once)
```

Every call status transition (`call.queued/dialing/in_progress/completed/failed`)
is delivered as a signed POST with retries (empty `events` = all). Verify the
`X-Voice-Signature: t=<unix>,v1=<hmac>` header: HMAC-SHA256 of `"{t}.{body}"`
with your endpoint secret (Stripe-style; reject stale timestamps).

### Inbound calls

```bash
curl -X POST localhost:8000/v1/phone-numbers -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"e164":"+14155550123","agent_id":"<id>"}'
```

Point your Plivo number's answer URL at `https://<PUBLIC_BASE_URL>/v1/telephony/inbound`.
When a call arrives, we map the dialed number → agent, verify the Plivo
signature, and connect it to the same pipeline (`direction: inbound`).

### Limits, quotas & usage

- **Rate limit**: per-tenant `rate_limit_per_min` (default 120) → `429` over budget.
- **Quotas** at `POST /v1/calls`: `max_concurrent_calls` (live calls) and optional `monthly_call_cap` → `429`.
- **Usage**: `GET /v1/usage?from=&to=` → billable `total_seconds` + `call_count` (defaults to current month).

### Logging, auditing & content (SendGrid-style)

Every call has a complete, queryable record — what was called, the outcome,
error codes, and the full transcript.

```bash
curl localhost:8000/v1/calls?status=failed&direction=outbound -H "Authorization: Bearer $KEY"
#   → activity feed (filter by status/direction/to/from/error_code/date, paginated)

curl localhost:8000/v1/calls/<id>/events    -H "Authorization: Bearer $KEY"
#   → the RAW CALL LOG: ordered timeline of call.queued → call.dialing →
#     call.in_progress → carrier.hangup → call.completed/failed, each with ts,
#     data, and error_code

curl localhost:8000/v1/calls/<id>/transcript -H "Authorization: Bearer $KEY"
#   → the conversation content: [{role, text, t}, ...]

curl localhost:8000/v1/stats                 -H "Authorization: Bearer $KEY"
#   → {total_calls, by_status, by_error_code, failure_rate, total_seconds, avg_seconds}
```

- **Error codes** are stable: `carrier_unauthorized`, `carrier_error`, `busy`,
  `no_answer`, `rejected`, `invalid_number`, `config_error`, `provider_timeout`,
  `pipeline_error`. Carrier outcomes (busy/no-answer) come from Plivo's hangup
  callback to `/v1/telephony/status` and mark the call failed with the reason.
- **Transcript** is captured live during the call and persisted on hang-up
  (also included in the `call.completed` webhook).
- The same events drive both the **timeline** and the **webhooks** — they never
  drift (`app/events.py`).

### Other endpoints

- `POST/GET/PATCH/DELETE /v1/connections` · `…/agents` · `POST/GET/DELETE /v1/api-keys` · `…/webhooks` · `…/phone-numbers`
- `GET /v1/calls` (activity) · `GET /v1/calls/{id}` · `…/events` · `…/transcript` · `GET /v1/stats` · `GET /v1/usage` · `GET /v1/providers`
- `GET /healthz` (liveness) · `GET /readyz` (DB + migrations + master key)

### Encryption at scale & RLS

The master key is pluggable (`KEY_PROVIDER=env|kms`). Set `KEY_PROVIDER=kms` +
`KMS_KEY_ID` to wrap tenant DEKs with AWS KMS (boto3, lazy-loaded). Optional
Postgres row-level security (defense-in-depth over the repo's tenant scoping) is
in `app/db/rls.sql` — apply it with the two-role setup it documents and set
`ENABLE_RLS=1`.

### Running the worker

```bash
python -m app.worker     # drains the dial + webhook-delivery queues
```

Run one or more alongside the API (`python run.py`). Claims use Postgres
`FOR UPDATE SKIP LOCKED`, so multiple workers are safe; failures back off
exponentially; a per-provider circuit breaker avoids hammering a down carrier;
SIGTERM drains gracefully.

### Browser playground (dev only)

Open **http://localhost:8000/** → Pipecat's prebuilt UI (live transcripts,
metrics/TTFB panel, event log). It runs a mic call against your seeded agent
(`DEV_AGENT_ID`) using that agent's stored connections. Mounted only when
`ENABLE_PREBUILT_UI=1` and `ENV!=prod`. Wiring in `app/prebuilt.py`.

[SmallWebRTC]: https://docs.pipecat.ai/server/services/transport/small-webrtc

## What comes back

During the call the agent can call two tools:

- `record_result(key, value)` — capture structured outcomes.
- `end_call(summary)` — hang up cleanly (plays any in-flight speech first).

These accumulate in a `CallOutcome` (`{data, summary, ended_by_agent}`) that
`run_call` returns and logs on hang-up. Persisting outcomes (DB / webhook) is
the next thing to wire up.

## Tuning latency & voice quality

Conversational feel is dominated by two things: **LLM time-to-first-token** (the
gap before the bot replies) and **TTS expressiveness** (how robotic it sounds).
With `VOICE_DEBUG_LOGGING=1`, the per-stage TTFB is printed to the console and
shown in the prebuilt UI's metrics panel — STT and TTS are usually tens to a few
hundred ms; if the bot feels laggy, the LLM is almost always the culprit.

**Latency (LLM).** Use a fast provider. Measured TTFT on this stack:

| Model | TTFT |
| ----- | ---- |
| `groq` / `llama-3.1-8b-instant` | **~310 ms** ✅ |
| `groq` / `llama-3.3-70b-versatile` | ~430 ms (smarter) |
| `openrouter` / `*:free` | 3–4 s ❌ (shared/queued — avoid for voice) |

Groq has a free tier and is the default. Get a key at console.groq.com →
`GROQ_API_KEY`. Avoid OpenRouter `:free` models — they're multi-second.

**Voice (TTS).** Cartesia **`sonic-3`** is far warmer than `sonic-2`. Shape the
delivery without code changes:

- `VOICE_TTS_EMOTION` — free-form tone, e.g. `"positive and warm"`, `"excited"`, `"calm"`
- `VOICE_TTS_SPEED` — `0.6`–`1.5` (lower = more relaxed)
- `VOICE_TTS_VOICE_ID` — the voice itself matters most; swap for a more
  expressive Cartesia voice if a particular one sounds flat
- The system prompt (`app/prompts.py`) also asks for contractions and natural
  rhythm — clipped, formal prompts sound robotic even with a good voice

All of these can be set per call via the `agent` payload (`voice_id`, `llm_model`)
or globally via env.

## Layout

```
app/
  main.py          FastAPI app: lifespan, /v1 router (require_tenant), carrier router
  settings.py      typed, validated config (DB URL, master key, env)
  routes.py        /v1/calls (async, idempotent) + carrier telephony webhooks
  worker.py        background worker: drains dial + webhook queues (python -m app.worker)
  queue.py         Postgres job queue (FOR UPDATE SKIP LOCKED)
  reliability.py   backoff + circuit breaker
  ratelimit.py     per-tenant fixed-window rate limit
  events.py        emit_call_event: timeline row + webhook (audit log)
  transcript.py    observer that captures conversation turns
  webhooks/        signing.py · events.py (fan-out) · delivery.py (signed POST)
  runner.py        per-call lifecycle (opener, end frame)
  pipeline.py      STT → LLM → TTS assembly + LLM context (only pipeline shape)
  prompts.py       system prompt (instructions + voice rules + context)
  schemas.py       AgentConfig, CallContext
  config.py        ResolvedCreds + VoiceConfig + SUPPORTED_PROVIDERS
  registry.py      the name → factory Registry used by every pluggable layer
  transport.py     browser WebRTC transport (dev/test calls)
  prebuilt.py      Pipecat playground UI at /client (dev only)
  admin.py         CLI: create-tenant / seed-dev
  db/              SQLAlchemy async — engine.py, models.py, repositories.py, rls.sql
  crypto/          envelope encryption — keyprovider.py (env + KMS KEK), envelope.py (DEK + AES-GCM)
  auth/            apikey.py (argon2 keys), dependencies.py (require_tenant / call session)
  security/        ssrf.py (URL guard), redaction.py (log scrubber)
  tenancy/         resolve.py — connections → decrypted creds → VoiceConfig
  api/             connections · agents · api_keys · webhooks · usage · phone_numbers · activity · health
  providers/       AI legs — registered factories taking ResolvedCreds
    stt.py · tts.py · llm.py · __init__.py (build_stt/build_tts/build_llm)
  telephony/       PSTN carriers behind one interface
    base.py (TelephonyProvider) · plivo.py · __init__.py (get_provider)
  tools/           LLM-callable tools behind a registry
    base.py (Tool, ToolContext, CallOutcome) · builtin.py · __init__.py
alembic/           migrations  ·  docker-compose.yml  ·  .env.example
```

## Modularity — how to extend

Everything pluggable is a **registry entry**: a self-contained module that
registers itself, selected by name. You never edit a central `if/elif`.

| Add a…            | Do this                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| **STT/TTS/LLM**   | New factory in `providers/{stt,tts,llm}.py` taking `ResolvedCreds`, `@*_registry.register("name")`; add `"name"` to `SUPPORTED_PROVIDERS` in `config.py`. |
| **Telephony carrier** | New `telephony/<carrier>.py` subclassing `TelephonyProvider`, `@telephony_registry.register("name")`, import in `telephony/__init__.py`; add to `SUPPORTED_PROVIDERS`. |
| **Agent tool**    | New `Tool` subclass in `tools/builtin.py` with `@tool_registry.register("name")`; add to `DEFAULT_TOOLS` or pass per call. |

Factories take a `ResolvedCreds` (decrypted key + settings) — they never read
process env, so they work per-tenant. `GET /v1/providers` lists what's
registered + the supported allow-list.

## Roadmap

Phases 1–4 are done:
- **P1** — auth + tenancy, Postgres persistence, encrypted BYO connections, SSRF + log redaction.
- **P2** — async dial queue + worker, `GET /v1/calls/{id}`, HMAC-signed webhooks with retries, backoff + circuit breaker, graceful shutdown.
- **P3** — per-tenant rate limits/quotas + usage metering, inbound calls (number → agent), KMS-pluggable master key, optional Postgres RLS.
- **P4** — observability/audit: per-call event timeline (`/events`), transcript content (`/transcript`), stable error codes incl. carrier hangup causes, activity feed (`/v1/calls`) and `/v1/stats`.

Possible next: load testing at scale, billing/cost on top of usage, more carriers (Twilio/Telnyx) and providers (just new registry entries), per-request provider overrides.
