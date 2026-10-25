# Offhook — Engineering Architecture & Implementation Guide

> Internal reference for engineers. Covers the full architecture and
> implementation of the Offhook voice-calling platform: the backend API, the
> async worker, the voice pipeline, multi-tenancy, security, telephony, and the
> three frontends. Last updated against the current `main`.

---

## 1. What this system is

Offhook is a **multi-tenant API platform for AI phone calls** — conceptually
"Twilio + Retell + SendGrid for voice agents." A tenant:

1. brings their own provider credentials (STT, TTS, LLM, telephony) as encrypted **connections**;
2. defines **agents** (instructions + voice + which connections to use);
3. places **calls** (`POST /v1/calls`) or receives **inbound** calls;
4. gets a complete audit trail per call: an event timeline, the transcript, a WAV recording, and signed webhooks.

A call runs a real-time **STT → LLM → TTS** loop over a phone line (PSTN via a
carrier) or a browser mic (WebRTC). The media/orchestration layer is
[Pipecat](https://github.com/pipecat-ai/pipecat) (pinned `0.0.101`).

### Tech stack
- **Language/runtime:** Python 3.13, asyncio throughout.
- **Web framework:** FastAPI + Uvicorn.
- **Voice runtime:** `pipecat-ai==0.0.101` (extras: cartesia, deepgram, openai, runner, silero, webrtc) + `pipecat-ai-small-webrtc-prebuilt==2.5.0`.
- **Datastore:** PostgreSQL only (no Redis). SQLAlchemy 2.0 async + `asyncpg` + Alembic.
- **Crypto:** `cryptography` (AES-GCM), `argon2-cffi` (API-key hashing), `pyjwt[crypto]` (Clerk JWT).
- **Config:** `pydantic-settings`.
- **Frontends:** Vite + React + TypeScript (3 separate apps). Dashboard auth via **Clerk**.

### Two long-running processes
- **API server** — `python run.py` (Uvicorn on `:8000`). Serves all HTTP, the carrier media-stream WebSocket, and runs the per-call voice **pipeline** (the WS handler executes the call in-process).
- **Worker** — `python -m app.worker`. Drains two Postgres-backed queues: the **dial** queue (places outbound calls) and the **webhook delivery** queue. Multiple instances are safe.

> Important separation: **the worker only dials and delivers webhooks.** The
> live media pipeline runs inside the **API server** (the carrier opens a
> WebSocket to `/v1/telephony/stream`, which the API server handles). Editing
> pipeline/route code requires restarting the API server, not the worker.

---

## 2. Repository layout

```
app/
  main.py            FastAPI app: CORS, lifespan, router mounting, auth wiring
  run.py (root)      Uvicorn entrypoint
  settings.py        pydantic-settings (all env vars, validated at boot)
  logger.py          loguru sink + redaction patcher
  registry.py        generic name→factory Registry (the extension primitive)
  config.py          ResolvedCreds, VoiceConfig, SUPPORTED_PROVIDERS
  schemas.py         AgentConfig, CallContext (pipeline input)
  prompts.py         build_system_prompt(), build_opener()
  pipeline.py        build_pipeline_task() — assembles the pipecat pipeline
  runner.py          run_call() — per-call lifecycle (opener, recording, end)
  transport.py       browser WebRTC transport factory
  textfilter.py      ToolCallTextFilter + strip_tool_syntax (tool-call leak guard)
  transcript.py      TranscriptCollector observer (conversation content)
  recording.py       CallRecorder + WAV encode + save
  routes.py          /v1/calls, /v1/me, /v1/providers, carrier webhooks (answer/stream/status/inbound)
  queue.py           Postgres job queue (FOR UPDATE SKIP LOCKED)
  reliability.py     backoff_seconds + CircuitBreaker
  ratelimit.py       per-tenant fixed-window rate limiter
  events.py          emit_call_event() — timeline row + webhook fan-out + classify_error
  worker.py          background worker (dial + webhook delivery)
  prebuilt.py        Pipecat playground UI at /client (dev only)
  admin.py           CLI: create-tenant, seed-dev
  session_store.py   legacy in-memory store (no longer on the hot path)

  api/               tenant CRUD routers
    connections.py agents.py api_keys.py webhooks.py phone_numbers.py
    usage.py activity.py health.py schemas.py
  auth/
    apikey.py        key generation/hash/verify (argon2id)
    clerk.py         Clerk session-JWT verification (JWKS, RS256)
    dependencies.py  require_tenant (dual principal), enforce_rate_limit, require_call_session
  crypto/
    keyprovider.py   EnvKeyProvider + KmsKeyProvider (master key / KEK)
    envelope.py      per-tenant DEK + AES-GCM encrypt/decrypt
  db/
    engine.py        async engine + session/session_scope
    models.py        all SQLAlchemy models
    repositories.py  tenant-scoped data access
    rls.sql          optional Postgres row-level security policies
  providers/
    stt.py tts.py llm.py __init__.py   registry-based AI provider factories
  telephony/
    base.py          TelephonyProvider ABC + StreamStart
    plivo.py twilio.py __init__.py     carrier implementations + get_provider
  tools/
    base.py builtin.py __init__.py     LLM tool abstraction + record_result/end_call
  tenancy/
    resolve.py       connections → decrypted creds → VoiceConfig
    users.py         Clerk user → tenant provisioning
  webhooks/
    signing.py events.py delivery.py   HMAC sign + fan-out + signed POST
  security/
    ssrf.py redaction.py               SSRF URL guard + log scrubbing

alembic/             migrations
dashboard/           Vite+React console (Clerk auth)  → :5273
website/             Vite+React marketing site         → :5274
docs/                Vite+React API docs portal        → :5275
docker-compose.yml   local Postgres
recordings/          call WAVs (gitignored)
```

~5,700 lines of Python across `app/`.

---

## 3. High-level architecture

```
                          ┌──────────────────────────────────────────────┐
   Dashboard (5273) ──────┤                                              │
   (Clerk JWT)            │            API server  (run.py, :8000)        │
   3rd-party API ─────────┤  FastAPI: /v1 (require_tenant + rate limit)   │
   (vk_ API key)          │          carrier webhooks (token auth)        │
                          │          WS /v1/telephony/stream → pipeline   │
                          └───────┬──────────────────────┬───────────────┘
                                  │                      │
                  enqueue dial    │                      │  read/write
                  job + webhooks   ▼                      ▼
                          ┌─────────────────┐     ┌───────────────────────┐
                          │  PostgreSQL     │◀────┤  Worker (app.worker)  │
                          │  (single store) │     │  - dial queue          │
                          └─────────────────┘     │  - webhook deliveries  │
                                                  └───────────┬───────────┘
                                                              │ place_call (REST)
                                                              ▼
                  ┌──────────────────────────────────────────────────────┐
                  │  Carrier (Plivo / Twilio)                              │
                  │  - dials the PSTN number                              │
                  │  - fetches our answer webhook → returns TwiML/PlivoXML │
                  │  - opens media-stream WS back to the API server       │
                  └──────────────────────────────────────────────────────┘
                                       │ mu-law 8kHz audio
                                       ▼
                  ┌──────────────────────────────────────────────────────┐
                  │  Pipecat pipeline (in API server, per call)           │
                  │  transport.in → STT → ctx-agg → LLM → tool-filter →   │
                  │  TTS → transport.out → (recorder)                     │
                  │  providers (Deepgram/Cartesia/Groq/...) over HTTP/WS   │
                  └──────────────────────────────────────────────────────┘
```

The carrier reaches the API server over the public internet, so in dev you need
a tunnel (ngrok) and `PUBLIC_BASE_URL` set to it.

---

## 4. Configuration (`app/settings.py`)

All config is environment-driven via `pydantic-settings`, loaded once into the
`settings` singleton and validated at import. Production requires several values
or the process refuses to start.

| Env var | Default | Purpose |
|---|---|---|
| `ENV` | `dev` | `dev`/`prod`. In `prod`, several guards are enforced (below). |
| `DATABASE_URL` | `postgresql+asyncpg://voice:voice@localhost:5432/voice` | Async SQLAlchemy URL. |
| `MASTER_ENCRYPTION_KEY` | none | base64 of 32 bytes; the KEK that wraps tenant DEKs. **Required in prod.** |
| `MASTER_KEY_ID` | `v1` | Id recorded on each wrapped DEK (rotation). |
| `KEY_PROVIDER` | `env` | `env` or `kms`. |
| `KMS_KEY_ID` | none | Required when `KEY_PROVIDER=kms`. |
| `PUBLIC_BASE_URL` | none | Public https URL carriers call back on. **Required in prod.** |
| `RECORDINGS_DIR` | `recordings` | Where call WAVs are written. |
| `CORS_ORIGINS` | `localhost:5273,4273,5173,5174,5175` | Dashboard origins allowed for browser CORS. |
| `ENABLE_PREBUILT_UI` | `1` | Dev playground at `/`. **Must be 0 in prod.** |
| `DEV_AGENT_ID` | none | Agent the playground talks to. |
| `WEBHOOK_ALLOW_PRIVATE` | `0` | Dev-only: allow webhook delivery to private/loopback. **Must be 0 in prod.** |
| `ENABLE_RLS` | `0` | Set `app.current_tenant` GUC per request (needs RLS policies + two-role DB). |
| `CLERK_ISSUER` | none | Clerk issuer (e.g. `https://x.clerk.accounts.dev`). Enables dashboard login. |
| `CLERK_JWKS_URL` | derived | JWKS endpoint; derived from issuer if unset. |
| `LOG_LEVEL` | `DEBUG` | loguru level (`DEBUG` surfaces pipecat per-stage metrics). |

**Prod validators** (`Settings._prod_requirements`): require `MASTER_ENCRYPTION_KEY`
and `PUBLIC_BASE_URL`; forbid `ENABLE_PREBUILT_UI` and `WEBHOOK_ALLOW_PRIVATE`.

Frontend env (`dashboard/.env`): `VITE_API_URL` (default `http://localhost:8000`),
`VITE_CLERK_PUBLISHABLE_KEY`.

---

## 5. Data model (PostgreSQL)

17 tables. Every tenant-scoped table carries `tenant_id` (FK + index). UUID PKs
(`gen_random_uuid()`/`uuid4`). All timestamps `timestamptz`. JSONB for flexible
payloads. **Secrets are never stored in plaintext.**

### Identity & tenancy
- **`tenants`** — `id, name, slug(unique), status('active'|'suspended'), rate_limit_per_min(120), max_concurrent_calls(10), monthly_call_cap(nullable), created_at, updated_at`. A tenant is a workspace; all data is scoped to it.
- **`users`** — `id, clerk_user_id(unique), tenant_id, email, created_at`. A human who signs into the dashboard via Clerk. First login auto-provisions a tenant (one user → one tenant today).
- **`api_keys`** — `id, tenant_id, prefix(unique, plaintext lookup handle), key_hash(argon2id), name, last_used_at, revoked_at, expires_at(nullable), created_at`. Machine credential.

### Encryption
- **`tenant_keys`** — `tenant_id(PK), wrapped_dek(bytea), master_key_id, created_at`. One data-encryption key per tenant, wrapped by the master key.
- **`connections`** — `id, tenant_id, name, provider_kind('stt'|'tts'|'llm'|'telephony'), provider_name, ciphertext(bytea), nonce(bytea, 12B), created_at, updated_at`. Encrypted BYO provider credentials. Unique `(tenant_id, name)`.

### Agents & calls
- **`agents`** — `id, tenant_id, name, company, role, instructions, first_message, voice_id, llm_model, {stt,tts,llm,telephony}_connection_id, provider_settings(jsonb), tool_ids(uuid[]), created_at, updated_at`. Reusable persona referencing connections per leg. `provider_settings` = non-secret tunables `{stt:{model}, tts:{voice_id,model,emotion,speed}, llm:{model}, language}`. `tool_ids` references `custom_tools` the agent may call.
- **`custom_tools`** — `id, tenant_id, name, description, parameters(jsonb), method, url, headers_ciphertext(bytea), headers_nonce(bytea), timeout_seconds, created_at, updated_at`. Tenant-defined HTTP tools the LLM can call mid-call (§11). Auth headers encrypted with the tenant DEK; unique `(tenant_id, name)`.
- **`calls`** — `id, tenant_id, agent_id, direction('outbound'|'inbound'|'web'), status, to_number, from_number, provider_call_id, session_token(unique), session_consumed_at, call_context_snapshot(jsonb), outcome(jsonb), error, error_code, transcript(jsonb), recording_path, created_at, started_at, ended_at`. The `call_context_snapshot` freezes the resolved `{agent, context, metadata, connections, settings, language, telephony_provider, from_number}` at reserve time — it replaces the old in-memory session store and lets the media-stream handler re-resolve everything later. **No secrets are stored here.**

### Observability
- **`call_events`** — `id, tenant_id, call_id, type, data(jsonb), error_code, ts`. Append-only timeline (the "raw call log"). Index `(call_id, ts)`, `(tenant_id, ts)`.
- **`usage_records`** — `id, tenant_id, call_id, kind, seconds, created_at`. One row per completed call's billable seconds.

### Async infrastructure (Postgres-as-queue)
- **`call_jobs`** — `id, tenant_id, call_id, kind('dial'), status('queued'|'done'|'failed'), run_after, leased_until, attempts, max_attempts(5), last_error, created_at, updated_at`. The dial queue.
- **`webhook_endpoints`** — `id, tenant_id, url, secret_ciphertext(bytea), secret_nonce(bytea), events(jsonb array; empty=all), enabled(bool), created_at`. The signing secret is encrypted with the tenant DEK.
- **`webhook_deliveries`** — `id, tenant_id, endpoint_id, call_id, event, payload(jsonb), status('queued'|'delivered'|'failed'), run_after, leased_until, attempts, max_attempts(8), response_code, last_error, created_at, updated_at`. The webhook delivery queue.
- **`idempotency_keys`** — `id, tenant_id, key, request_hash, response_code, response_body(jsonb), created_at`. Unique `(tenant_id, key)`.
- **`rate_limit_counters`** — `tenant_id, window_start (PK pair), count`. Fixed-window API counters.

### Inbound
- **`phone_numbers`** — `id, tenant_id, e164(unique), agent_id, created_at`. Maps an inbound number to an agent.

Access goes through **`app/db/repositories.py`**, whose functions all take
`tenant_id` first so a cross-tenant query is structurally hard. Engine/sessions
in `app/db/engine.py`: `get_session` (FastAPI dependency, commits on clean
return) and `session_scope()` (async context manager for non-request code:
worker, WS handler, CLI).

---

## 6. Authentication & multi-tenancy

Two principals, one resolution path. `require_tenant` (`app/auth/dependencies.py`)
is mounted as a **router-level dependency** on the `/v1` router, so every
business route is authenticated by default. It returns a `TenantContext`
(`tenant_id, api_key_id?, user_id?, email?, principal, rate_limit_per_min`).

```
Authorization: Bearer <token>
        │
        ├── token startswith "vk_"  → API-key path (_from_api_key)
        └── otherwise               → Clerk JWT path (_from_clerk)
```

### API keys (machine principal)
- Format `vk_<env>_<prefix>_<secret>` (e.g. `vk_dev_ab12cd34ef56_<43-char base64url>`).
- `prefix` is stored plaintext + indexed for O(1) lookup; `secret` is stored only as **argon2id** (`app/auth/apikey.py`). Plaintext returned **once** at creation.
- Verification: look up active key by prefix → argon2 verify → check `expires_at` → check tenant active → `touch` `last_used_at`. On miss, a **dummy argon2 verify** runs to flatten timing (no existence oracle).
- Errors: `401` (missing/malformed/wrong/revoked/expired), `403` (tenant suspended).

### Clerk JWT (dashboard user principal)
- The dashboard sends the Clerk **session JWT** as the bearer token.
- `app/auth/clerk.py` verifies it with PyJWT's `PyJWKClient` against Clerk's JWKS (RS256), checking `iss == CLERK_ISSUER`, `exp`, `iat`, `sub`. (`verify_aud=False` — Clerk session tokens have no fixed `aud`.)
- `claims_to_identity` extracts `(clerk_user_id=sub, email)`. (Default Clerk session tokens omit email → stored as null; the dashboard shows email from the Clerk client SDK instead. Add a Clerk JWT template if you want email server-side.)
- `app/tenancy/users.py:resolve_or_provision` maps the Clerk user → tenant, **auto-provisioning** a workspace on first login (handles the unique-constraint race by re-selecting).

### Carrier endpoints (no API key)
`/v1/telephony/{answer,stream,status,inbound}` are hit by the carrier, not a
tenant. They authenticate via a **single-use `session_token`** minted on the
`calls` row at reserve time and embedded in the answer/stream/status URLs.
`require_call_session` / `_lookup_call(consume=...)` resolves and (for the
stream) consumes it. Plivo/Twilio webhook signature verification
(`verify_webhook`) is available as defense-in-depth.

### RLS (optional, off by default)
When `ENABLE_RLS=1`, `require_tenant` runs `SET LOCAL app.current_tenant` per
transaction. Combined with the policies in `app/db/rls.sql` and a two-role DB
setup (a non-owner API role + a BYPASSRLS worker role), Postgres enforces tenant
isolation as defense-in-depth over the repo layer. Off by default because the
worker/carrier paths query by job/token across tenants.

---

## 7. Secrets & envelope encryption (`app/crypto/`)

Two-layer envelope encryption so the DB never holds anything usable on its own.

```
Master key (KEK)            ── env (MASTER_ENCRYPTION_KEY) or AWS KMS
   wraps ▼
Per-tenant DEK (32B)        ── stored wrapped in tenant_keys.wrapped_dek
   encrypts ▼
Connection secret blob      ── AES-GCM → connections.ciphertext + nonce
```

- **`keyprovider.py`** — `KeyProvider` protocol with `wrap_dek`/`unwrap_dek`.
  - `EnvKeyProvider`: master keys from env, addressed by id (`MASTER_KEY_ID` + optional `MASTER_ENCRYPTION_KEY_<id>` for rotation). AES-GCM key wrapping (nonce prepended). `self_test()` wraps+unwraps a probe (used by `/readyz`).
  - `KmsKeyProvider`: lazy `boto3` KMS `Encrypt`/`Decrypt`. Selected by `KEY_PROVIDER=kms`.
- **`envelope.py`**:
  - `get_or_create_tenant_dek(db, tenant_id)` — unwrap the stored DEK, or mint+wrap+persist one on first use.
  - `encrypt_secret/decrypt_secret(dek, ..., aad)` — AES-GCM with **AAD = `tenant_id|connection_id|provider_name`**, binding ciphertext to its row (anti confused-deputy / replay).
- Decrypted secrets live only transiently in memory during a call; never logged, returned, or persisted in plaintext (e.g., never in `call_context_snapshot`).
- The same machinery encrypts webhook signing secrets (`provider_name="webhook"`).
- **Backups** contain only ciphertext + wrapped DEKs. The master key lives outside the DB; lose it and the secrets are unrecoverable (by design).

---

## 8. The provider abstraction

The single extension primitive is **`app/registry.py:Registry[T]`** — a
name→factory map with a `register(name)` decorator, `get(name)`, and `names()`.
Five registries exist: STT, TTS, LLM, telephony, tools. Adding a provider is a
self-contained module + one registry entry + a `SUPPORTED_PROVIDERS` allow-list
addition; no central dispatch to edit.

### ResolvedCreds & VoiceConfig (`app/config.py`)
- `ResolvedCreds{provider_name, secrets: dict, settings: dict}` — one decrypted leg. `.secret(key)` (raises if missing), `.setting(key, default)`.
- `VoiceConfig{stt, tts, llm, telephony?, language, debug_logging}` — everything one call needs, credentials already resolved. **No `os.environ` reads anywhere in the provider factories** — credentials always arrive as data.
- `SUPPORTED_PROVIDERS = {stt:{deepgram}, tts:{cartesia,openai}, llm:{groq,gemini,openrouter,openai}, telephony:{plivo,twilio}}` — the allow-list the connections API validates against.

### Factories (`app/providers/`)
Each `build_xxx(creds: ResolvedCreds)` returns a pipecat service. Defaults:
- **STT**: `deepgram` → `DeepgramSTTService(api_key, model=settings.get("model","nova-3"))`.
- **TTS**: `cartesia` → `CartesiaTTSService(api_key, voice_id(default 05a69c2d…), model(default "sonic-3"))`. Sonic-3 takes emotion/speed via `GenerationConfig`. `openai` → `OpenAITTSService`.
- **LLM** (all OpenAI-compatible via `OpenAILLMService` + hardcoded `base_url`): `groq`→`openai/gpt-oss-20b` (reasoning effort `low`) @ `api.groq.com/openai/v1`; `gemini`→`gemini-2.5-flash` @ Google's OpenAI-compat endpoint; `openrouter`→`google/gemini-2.5-flash`; `openai`→`gpt-4o-mini`. The **model** comes from the agent (`agent.llm_model` or `provider_settings.llm.model`), else the per-provider default. **`base_url` is fixed** (no arbitrary endpoints — locked design decision).

The pipeline calls `build_stt(cfg.stt)` etc.; it never names a concrete provider.

---

## 9. Resolving a call (`app/tenancy/resolve.py`)

`prepare_call(db, tenant_id, agent, *, context, metadata, need_telephony)` turns
the persisted world into:
- a `CallContext` (`agent: AgentConfig`, `context: dict`, `metadata: dict`) — no secrets, pipeline input;
- a `VoiceConfig` — decrypted `ResolvedCreds` per leg (unwraps the tenant DEK once, decrypts each connection, merges `agent.provider_settings[leg]` + overrides like `agent.voice_id`/`agent.llm_model`);
- `conn_ids` + `settings` to persist in the call snapshot for later re-resolution.

`voice_config_from_snapshot(db, tenant_id, snapshot, need_telephony)` re-derives
the `VoiceConfig` from a frozen snapshot at media-stream time (re-decrypts —
plaintext creds are never stored). This is the chicken-and-egg solver: the
carrier connects later with only a token; we look up the call, read the snapshot
(connection ids + settings + provider name), and re-resolve.

---

## 10. The voice pipeline (`app/pipeline.py`, `app/runner.py`)

`build_pipeline_task(transport, ctx, cfg, *, enable_rtvi, recorder)` assembles a
pipecat `PipelineTask`. Pipeline shape:

```
transport.input()
  → [RTVIProcessor]            (browser only: streams events to the client)
  → STT (Deepgram)
  → user context aggregator    (LLMContextAggregatorPair + Silero VAD)
  → LLM (with tools)
  → ToolCallTextFilter         (strips verbalized tool-call syntax)
  → TTS (Cartesia)
  → transport.output()
  → assistant context aggregator
  → [AudioBufferProcessor]     (if recording: mono user+bot mix)
```

Key details:
- **System prompt + opener** (`app/prompts.py`): `build_system_prompt(ctx)` = agent instructions + voice constraints (short sentences, no markdown, "call end_call when done") + a `CALL CONTEXT` block rendering the `context` dict. The deterministic **opener** is pre-loaded into the `LLMContext` as the first assistant turn so the LLM has continuity and doesn't re-greet.
- **VAD**: Silero, placed on the **user aggregator** for WebRTC, and on the **transport** for telephony (because carriers deliver continuous mu-law — turn detection needs VAD on input).
- **Tools** attached via `LLMContext(tools=build_tools_schema())`; pipecat's adapter converts our `ToolsSchema` to OpenAI tool format. See §11.
- **Observers** (not in the data path; watch frames): `TranscriptCollector` (captures conversation turns into the `CallOutcome`), pipecat's metrics/latency/transcription/LLM log observers (DEBUG), and `RTVIObserver` (browser only, `bot_llm_enabled=False` to avoid double transcripts).
- **`PipelineParams(enable_metrics, enable_usage_metrics)`** → per-stage TTFB/usage logs.

`run_call(transport, ctx, cfg, *, enable_rtvi, recorder)` (`runner.py`) owns the
lifecycle: on `on_client_connected` it speaks the opener (`TTSSpeakFrame`) and,
if recording, calls `audiobuffer.start_recording()`; on `on_client_disconnected`
it queues an `EndFrame`. Returns the `CallOutcome` (`{data, summary,
ended_by_agent, transcript}`).

### Tool-call leak filter (`app/textfilter.py`)
Small models sometimes **verbalize** a tool call (emit Llama's
`<function=name>{...}</function>` as text instead of a structured call), and the
TTS would speak it. `ToolCallTextFilter` is a `FrameProcessor` between LLM and
TTS implementing a **streaming suppressor**: tokens arrive split, so a per-chunk
regex won't work. It holds state (`_suppress`, `_hold` for partial `<function`
at a chunk boundary, `_skip_close` for a trailing `</function>` in the next
chunk), passes normal text straight through (zero latency), and drops from
`<function` through the JSON's closing `}` (+ optional `</function>`). It mutates
`LLMTextFrame.text` in place. `strip_tool_syntax()` is the one-shot regex version
used to sanitize the stored transcript. Tested clean at every chunk size 1..N.

---

## 11. Tools / function calling (`app/tools/`)

- `Tool` ABC: a `schema` (pipecat `FunctionSchema`, the LLM-visible definition) + `make_handler(ctx: ToolContext)` returning the async handler bound to one call's state. Registered in `tool_registry`.
- Built-ins (`builtin.py`):
  - **`record_result(key, value)`** — captures a structured outcome into `CallOutcome.data`.
  - **`end_call(summary)`** — sets `outcome.summary`/`ended_by_agent`, then **queues** an `EndFrame` (queued, not pushed, so in-flight goodbye TTS plays first).
- `build_tools_schema(names?, custom_tools?)` → `ToolsSchema`; `register_handlers(llm, ToolContext, names?, custom_tools?)` binds handlers. `DEFAULT_TOOLS = [record_result, end_call]`. Per-call tool sets are supported (pass `names`).
- The model produces structured `tool_calls`; pipecat invokes the handler and feeds the result back. The text filter (§10) is the safety net for models that leak instead.

### Custom HTTP tools (tenant-defined, `app/tools/http_tool.py`)

A tenant declares a function the agent can call mid-call to fetch live data from
their own API (e.g. "check_order_status" by order ID). Stored in `custom_tools`
(name, description, JSON-Schema `parameters`, `method`, `url`, **encrypted**
`headers`, `timeout_seconds`); attached to agents via `agents.tool_ids`.

- **Resolution mirrors connections.** `prepare_call` freezes `tool_ids` into the call snapshot (ids only). At call time `resolve_custom_tools` loads the rows and **re-decrypts** the auth headers with the tenant DEK (AAD = `tenant_id|tool_id|"tool"`) into `ResolvedTool` objects — plaintext headers are never stored. They pass through `run_call → build_pipeline_task` and register as LLM handlers alongside the built-ins.
- **Request mapping** (`_build_request`): the model's arguments only ever fill declared `{param}` path placeholders (URL-encoded) or become the query string (GET) / JSON body (POST). They can never change the host, scheme, method, or headers.
- **Security**: the URL is SSRF-validated at write time (API) **and again** at call time, with a post-templating **host-pin** check (templating can't redirect to an internal address); a per-tool `timeout` (≤20s) bounds the conversation stall; responses are truncated (`MAX_RESULT_CHARS = 8000`). A handler **never raises into the pipeline** — failures return `{"error": …}` so the agent apologizes and continues. Header values are write-only in the API (`has_auth` boolean only).
- **API**: `POST/GET/PATCH/DELETE /v1/tools` (`app/api/tools.py`). Names must be valid identifiers and can't collide with the built-ins.

---

## 12. Outbound call lifecycle (end to end)

1. **`POST /v1/calls`** `{agent_id, to_number, from_number?, context?, metadata?}` (+ optional `Idempotency-Key` header). Auth + rate limit run first.
   - **Idempotency**: if the header is present and a stored response exists with the same `request_hash`, return it verbatim; reuse with a different body → `409`.
   - **Quotas**: `count_active_calls >= max_concurrent_calls` → `429`; monthly cap exceeded → `429`.
   - `prepare_call(need_telephony=True)` resolves creds (validates connections). A **`session_token`** (`secrets.token_urlsafe(32)`) is minted; a `calls` row is created `status=queued` with the frozen `call_context_snapshot` (incl. `telephony_provider`).
   - A **`call_jobs`** row (`kind='dial'`) is enqueued; `emit_call_event(call.queued)` records the timeline event + fans out webhooks. Returns `{id, status:"queued", direction, provider_call_id:null}` immediately.
2. **Worker dial** (`app/worker.py:_process_dial`): claims the job (SKIP LOCKED), re-resolves creds from the snapshot, builds `answer_url` + `status_url` from `PUBLIC_BASE_URL` (both carrying `?session_token=`), and calls `provider.place_call(...)` for the provider named in the snapshot. A **circuit breaker** (`telephony:plivo`/`twilio`) guards it. On success: `status=dialing`, store `provider_call_id`, `emit(call.dialing)`, complete the job. On retryable failure: reschedule with backoff; on exhaustion: `status=failed` + `emit(call.failed)` with a classified `error_code`. A resolution error → `config_error` (terminal).
3. **Carrier dials** the PSTN number; on answer it **fetches the answer webhook** `POST /v1/telephony/answer?session_token=` → we look up the call (non-consuming), pick the provider from the snapshot, and return the carrier document (PlivoXML or TwiML) instructing it to open a media-stream WebSocket back to `/v1/telephony/stream`.
4. **Media stream** `WS /v1/telephony/stream`: accept → read JSON messages until `event=="start"` → resolve the token (query for Plivo, `start.customParameters` for Twilio) → `_lookup_call(consume=True)` (single-use) → re-resolve `VoiceConfig` from snapshot → `status=in_progress` + `emit(call.in_progress)` → build the carrier transport (with serializer) → `run_call(...)` runs the full pipeline until `end_call`/hangup.
5. **Completion**: save the recording (WAV → `recordings/<tenant>/<call>.wav`), set `status=completed|failed`, `error_code`, `outcome`, `transcript`, `recording_path`, `ended_at`; insert a `usage_records` row (billable seconds); `emit(call.completed|failed)` with summary/duration/transcript-length.
6. **Status callback** `POST /v1/telephony/status`: records `carrier.hangup` with the cause/code. If the media stream never ran (call still `queued/dialing/reserved`), it finalizes the call from the carrier signal (e.g. `busy`, `no_answer`, or `no_media` when a Twilio trial caller didn't press a key).

---

## 13. Inbound call lifecycle

1. Tenant maps a number → agent (`POST /v1/phone-numbers`) and points the carrier number's answer URL at `https://<host>/v1/telephony/inbound`.
2. On an incoming call the carrier POSTs `To`/`From` to `/v1/telephony/inbound`. We map `To` → `phone_numbers` → tenant + agent, `prepare_call(need_telephony=True)`, verify the carrier signature, create a `calls` row (`direction='inbound'`, `status='reserved'`, snapshot + token), `emit(call.received)`, and return the media-stream document.
3. From there it's identical to the outbound media-stream + completion path (the stream handler is direction-agnostic).

---

## 14. Telephony providers — Plivo vs Twilio

`TelephonyProvider` ABC (`app/telephony/base.py`): `place_call`, `answer_document`,
`parse_stream_start`, `build_transport`, `verify_webhook`. `StreamStart{stream_id,
call_id}`. `get_provider(name)` caches one stateless instance per name. The
provider used per call is resolved from the connection's `provider_name`
(persisted as `telephony_provider` in the call snapshot) — **no hardcoding**.

Both carriers deliver **mu-law 8kHz** over a WebSocket; pipecat's
`PlivoFrameSerializer` / `TwilioFrameSerializer` handle encoding + auto-hangup
(via REST, using the stored creds). VAD on the transport. Key differences learned
the hard way:

| | Plivo | Twilio |
|---|---|---|
| Outbound dial | `POST .../Call/` (JSON), `answer_url`+`hangup_url` | `POST .../Calls.json` (form), `Url`+`StatusCallback` |
| Answer doc | PlivoXML `<Response><Stream …>` | TwiML `<Response><Connect><Stream …>` |
| Stream URL query string | **preserved** → token via `?session_token=` | **dropped** → token passed as `<Parameter name="session_token">` |
| First WS message | `start` immediately | `connected`, then `start` |
| Token location at stream | URL query param | `start.start.customParameters.session_token` |
| Hangup signal field | `HangupCause` (`NORMAL_CLEARING`, `USER_BUSY`, `NO_ANSWER`…) | `CallStatus` (`completed`, `busy`, `no-answer`, `failed`, `canceled`) |
| Trial gotcha | — | plays a trial message and **waits for a keypress** before fetching the answer URL |

The stream handler is written to absorb both: it **reads until `event=="start"`**
(skipping Twilio's `connected`) and takes the token from the query **or**
`customParameters`. The status handler normalizes both fields (`UPPER`, `-`→`_`)
and maps them through `_HANGUP_CODES`.

---

## 15. The async job queue (`app/queue.py`, `app/worker.py`)

Postgres-only queue, generic over any model with the queue columns
(`call_jobs`, `webhook_deliveries`).

- **Claim** is one atomic statement: `UPDATE … SET leased_until=now()+lease, attempts=attempts+1 WHERE id = (SELECT id … WHERE status='queued' AND run_after<=now() AND (leased_until IS NULL OR leased_until<now()) ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. `SKIP LOCKED` means N workers never grab the same row (verified).
- **complete** → `status='done'/'delivered'`. **reschedule** → back off (`run_after = now()+delay`) and requeue, or mark terminal after `max_attempts`.
- **Worker loop** (`run`): claim+process one dial job, then one webhook delivery, else sleep (interruptible). Each item: claim in one short txn (lease), process off-transaction (network I/O), finalize in another txn. Exceptions are caught so the loop never dies. **SIGTERM/SIGINT** sets a stop event → graceful drain-and-exit.

---

## 16. Webhooks (`app/webhooks/`, `app/events.py`)

- **Unified emission**: `emit_call_event(db, tenant_id, call_id, type, data, error_code?)` writes a `call_events` row **and** calls `enqueue_event` to fan out to subscribed `webhook_endpoints` (empty `events` = all) in the **same transaction** — so the timeline and webhooks never drift.
- **Event types**: `call.queued`, `call.dialing`, `call.in_progress`, `call.completed`, `call.failed`, `call.received`, `carrier.hangup`.
- **Delivery** (worker, `delivery.py`): SSRF-validate the URL (dev bypass via `WEBHOOK_ALLOW_PRIVATE`), decrypt the endpoint's signing secret, POST a JSON envelope `{id, event, created, data}` with headers `X-Voice-Event`, `X-Voice-Delivery`, and `X-Voice-Signature: t=<unix>,v1=<hmac>`. 2xx = delivered; else retried (max 8) with backoff. A per-host circuit breaker avoids hammering a down endpoint.
- **Signature** (`signing.py`): `v1 = HMAC_SHA256(secret, "{t}.{raw_body}")`. Receivers recompute and constant-time compare, rejecting stale `t` (replay). `verify_signature` is provided for receivers/tests. Secret returned once on endpoint creation.

---

## 17. Reliability primitives (`app/reliability.py`)

- `backoff_seconds(attempt, base=1, cap=300)` — **full-jitter** exponential backoff (`uniform(0, min(cap, base·2^(attempt-1)))`) so retries from many workers don't synchronize.
- `CircuitBreaker(fail_threshold=5, reset_timeout=30)` — closed → (N consecutive failures) → open (for cooldown) → half-open (single probe) → closed. `get_breaker(key)` returns a per-process breaker keyed by `telephony:<provider>` or `webhook:<host>`.
- **Idempotency** — `Idempotency-Key` on `POST /v1/calls` caches the response (`idempotency_keys`), so a retried request never double-dials.

---

## 18. Rate limiting & quotas

- **Rate limit** (`app/ratelimit.py`): per-tenant fixed-window counter, one `rate_limit_counters` row per `(tenant, minute)`. Each request does an atomic upsert-increment (`ON CONFLICT DO UPDATE SET count=count+1 RETURNING count`); over `tenant.rate_limit_per_min` → `429` + `Retry-After: 60`. Enforced via `enforce_rate_limit`, a `/v1` router-level dependency (after `require_tenant`). Old windows pruned opportunistically.
- **Quotas** (`POST /v1/calls`): `max_concurrent_calls` (live calls in `queued/dialing/in_progress`) and optional `monthly_call_cap` (calls since `date_trunc('month', now())`). Either exceeded → `429`.

---

## 19. Observability & audit (the "SendGrid for calls" surface)

Per call:
- **Event timeline** — `GET /v1/calls/{id}/events` (ordered `call_events`).
- **Transcript** — `GET /v1/calls/{id}/transcript` (`[{role, text, t}]`, captured by `TranscriptCollector`, sanitized of tool syntax, persisted to `calls.transcript`).
- **Recording** — `GET /v1/calls/{id}/recording` (the mixed WAV; see §20).
- **Detail** — `GET /v1/calls/{id}` (status, `error_code`, `has_recording`, timing, outcome).

Account-level:
- **Activity feed** — `GET /v1/calls` with filters (`status, direction, to_number, from_number, error_code, since, until`) + `limit`/`offset` pagination.
- **Stats** — `GET /v1/stats` → `{total_calls, by_status, by_error_code, failure_rate, total_seconds, avg_seconds}` (defaults to the current month).
- **Usage** — `GET /v1/usage` → `{total_seconds, call_count}`.

**Error codes** (`app/events.py:classify_error` + carrier mapping):
`carrier_unauthorized, carrier_error, busy, no_answer, rejected, invalid_number,
config_error, provider_timeout, pipeline_error, no_media, unknown_error`.

**Log redaction** (`app/security/redaction.py`): a loguru patcher scrubs bearer
tokens, `vk_…` keys, and `api_key/auth_token/secret/password` values from every
log line. Logs run at `LOG_LEVEL=DEBUG` in dev to surface pipecat's per-stage
TTFB/usage metrics.

---

## 20. Audio recording (`app/recording.py`)

- A pipecat `AudioBufferProcessor` (mono, placed last in the pipeline) mixes the user + bot audio. `start_recording()` is called on connect; pipecat auto-`stop_recording()`s on the `EndFrame`, firing `on_audio_data` once with the full merged PCM.
- The handler fills a `CallRecorder` holder; on completion `save_recording` encodes WAV (`wave`, 16-bit, the stream sample rate, usually 8kHz) and writes `recordings/<tenant_id>/<call_id>.wav`; the path is stored on `calls.recording_path`.
- `GET /v1/calls/{id}/recording` streams it (`FileResponse`, `audio/wav`), tenant-scoped. The dashboard fetches it as an authed blob → object URL → `<audio>` + download.
- **Prod note:** local FS is for dev; point `RECORDINGS_DIR` at a mounted volume or swap `save_recording` for S3/GCS.

---

## 21. Security summary

- **Secrets at rest**: envelope encryption (§7); AAD-bound; never logged/returned; backups useless without the master key.
- **API keys**: argon2id; constant-ish verify timing; revocable + expirable.
- **Carrier endpoints**: single-use high-entropy session token + optional signature verification.
- **SSRF** (`app/security/ssrf.py`): `validate_public_url` requires https (http only in dev), rejects userinfo/odd ports, resolves DNS and blocks private/loopback/link-local/CGNAT/reserved/multicast/ULA + the cloud metadata IP. Used for `PUBLIC_BASE_URL` and webhook URLs. (Connect-time IP pinning for DNS-rebinding is the documented next step on the webhook fetch.)
- **CORS**: explicit origin allow-list.
- **RLS**: optional defense-in-depth (§6).
- **Log redaction**: §19.
- **Prebuilt UI / webhook-to-private**: hard-disabled in prod by settings validators.

---

## 22. Frontends

Three independent Vite + React + TypeScript apps, one shared aesthetic
("refined technical editorial": warm paper, ink, clay accent; Fraunces +
Hanken Grotesk + JetBrains Mono).

### Dashboard (`dashboard/`, :5273) — the tenant console
- **Auth**: Clerk (`@clerk/clerk-react`). `<ClerkProvider>` in `main.tsx` (graceful "configure Clerk" screen if `VITE_CLERK_PUBLISHABLE_KEY` is unset). `App.tsx` gates on `<SignedIn>/<SignedOut>` with a styled `<SignIn>`; a `TokenBridge` wires Clerk's `getToken()` into the API client.
- **API client** (`api.ts`): a `fetch` wrapper that injects `Authorization: Bearer <clerk token>`; `setTokenGetter` decouples it from Clerk. Typed methods for every endpoint. Recording fetched as an authed blob (`recordingUrl`).
- **Pages**: Overview (stats + breakdown bars + recent calls), Calls (filterable, **offset-paginated** activity table → CallDetail with event-timeline/transcript tabs, recording player, and a "New call" modal that `POST /v1/calls`), Agents (create with provider-aware LLM-model field), Connections (BYO keys; provider-specific secret fields incl. Twilio `account_sid`), API Keys (create-with-expiry, revoke), Webhooks, Numbers.
- **UI kit** (`ui.tsx`): custom `Select` (keyboard nav, click-outside, empty states — replaces native `<select>`), `Modal`, `Badge`, `Field`, toast, formatters, an inline icon set.

### Marketing site (`website/`, :5274)
Single-page landing: hero with a live "POST /v1/calls" code window, providers
strip, 3-step how-it-works, feature grid, observability split, CTA. Static; CTAs
link to the console + docs.

### Docs portal (`docs/`, :5275)
Sidebar-nav API reference (Introduction, Quickstart, Authentication, Connections,
Agents, Calls, Webhooks, Inbound, Logs, Errors). Reusable `Code` (curl/JSON tabs
+ copy + a lightweight syntax highlighter), `Endpoint` (method badge + path),
`Params` table, `Callout`. SPA routing (deploy with index.html fallback).

> Hosts are constants at the top of the frontend source (console/site/docs/API
> base) — swap for real domains in production.

---

## 23. Local development

```bash
# Postgres (docker, or a local instance with role/db 'voice')
docker compose up -d
# deps
uv venv && uv pip install -e .
# env: copy .env.example → .env, set MASTER_ENCRYPTION_KEY (base64 32B), DATABASE_URL, CLERK_ISSUER
alembic upgrade head                       # migrations (a separate deploy step; never auto-applied in prod)
python -m app.admin seed-dev               # prints an API key (once) + DEV_AGENT_ID; imports local provider keys as connections
python run.py                              # API on :8000
python -m app.worker                       # worker (separate terminal)
# frontends
cd dashboard && npm install && npm run dev # :5273 (needs VITE_CLERK_PUBLISHABLE_KEY)
cd website  && npm install && npm run dev  # :5274
cd docs     && npm install && npm run dev  # :5275
# real phone calls: tunnel so carriers can reach the webhooks
ngrok http 8000   →   set PUBLIC_BASE_URL=https://<id>.ngrok-free.app, restart the API server
```

- **`/healthz`** = liveness; **`/readyz`** = DB `SELECT 1` + migrations-at-head + master-key self-test (503 until ready). Use `/readyz` for load-balancer readiness.
- **Migrations**: Alembic, async env, `compare_type=True`. Current chain: `ea7bf1af6faa` (initial) → `10f86d9d56c9` (P2 queue+webhooks) → `db45dc3da4f9` (P3 limits/usage/inbound) → `6dedf19fa5e6` (P4 events/audit) → `13a95be99224` (users + api-key expiry) → `16bac60983cb` (recording_path) → `a1c4e7f29b30` (custom tools + `agents.tool_ids`).
- **Admin CLI** (`app/admin.py`): `create-tenant --name --slug`; `seed-dev` (tenant + key + connections-from-env + a demo agent).

---

## 24. Known limitations & production TODOs

- **Audio storage** is local FS; move to S3/GCS for multi-replica + durability.
- **Webhook SSRF** validates at write/send time but the connect-time IP pin (full DNS-rebinding defense) is still a TODO on the fetch path.
- **RLS** is opt-in and needs the two-role DB setup to be meaningful.
- **KMS** provider is implemented but untested against a live KMS.
- **One user → one tenant**; multi-user tenants / invites / roles are not built.
- **No agent edit endpoint** (create + delete only) — change a model by recreating.
- **Dashboard search** filters the current page client-side (substring), not server-side across pages.
- **`session_store.py`** is legacy (superseded by the `calls` snapshot) and can be removed.
- **Built-in tool selection per request** is supported by the registries but not exposed in the request schema (today: defaults + per-agent custom tools). Custom HTTP tools **are** tenant-configurable via `/v1/tools` + `agents.tool_ids`.
- **Custom tools have no per-call observability event** yet — invocations are logged (host + status, no secrets) but not written to `call_events`. A `tool.called` event is a natural add.
- **ngrok URLs are ephemeral** in dev — re-set `PUBLIC_BASE_URL` if the tunnel restarts.

---

## 25. Quick reference

**Tenant API (all `Authorization: Bearer`):**
```
POST/GET/PATCH/DELETE /v1/connections           BYO provider creds (encrypted)
POST/GET/DELETE       /v1/agents                personas
POST/GET/PATCH/DELETE /v1/tools                 tenant-defined LLM HTTP tools (encrypted headers)
POST/GET/DELETE       /v1/api-keys              keys (optional expiry)
POST/GET/DELETE       /v1/webhooks              signed event endpoints
POST/GET/DELETE       /v1/phone-numbers         inbound number → agent
POST/GET              /v1/calls                 place / list (filters + limit/offset)
GET                   /v1/calls/{id}            detail (status, error_code, has_recording)
GET                   /v1/calls/{id}/events     raw timeline
GET                   /v1/calls/{id}/transcript conversation content
GET                   /v1/calls/{id}/recording  WAV
GET                   /v1/stats                 aggregates
GET                   /v1/usage                 billable seconds + count
GET                   /v1/providers             supported providers
GET                   /v1/me                    current principal
```
**Carrier (token + signature auth):** `POST /v1/telephony/{answer,status,inbound}`, `WS /v1/telephony/stream`.
**Public:** `GET /healthz`, `GET /readyz`. **Dev:** `/`, `/client`, `/start`, `/api/offer` (prebuilt playground).

**Call statuses:** `queued → dialing → in_progress → completed | failed` (`reserved` for inbound pre-connect).
**Webhook events:** `call.{queued,dialing,in_progress,completed,failed,received}`, `carrier.hangup`.
**Error codes:** `carrier_unauthorized, carrier_error, busy, no_answer, rejected, invalid_number, config_error, provider_timeout, pipeline_error, no_media, unknown_error`.
**Providers:** STT `deepgram` · TTS `cartesia, openai` · LLM `groq, gemini, openrouter, openai` · telephony `plivo, twilio`.
```
