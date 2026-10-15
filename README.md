# Offhook

**Open-source, self-hostable API for AI phone calls.**

Give it a phone number and an agent, and Offhook places the call: speech-to-text, an LLM and text-to-speech, streamed over a real phone line. Bring your own provider keys, run it on your own infrastructure, and get back a transcript, a structured outcome and a full event log for every call.

Think Retell or Vapi, but you own it.

<!-- TODO: 15–20s demo clip of a real call (sound on) -->

## Why Offhook

- **Your keys, your infra.** Each tenant brings their own Deepgram, Cartesia, LLM and carrier keys. They are envelope-encrypted at rest and decrypted only for the length of a call.
- **Fast enough to feel human.** Built on [Pipecat](https://github.com/pipecat-ai/pipecat). With Groq's `llama-3.1-8b-instant`, the model starts replying in about 300 ms.
- **Production plumbing included.** Async dialing with idempotency keys, signed webhooks with retries, per-tenant rate limits and quotas, inbound calls, stable error codes and a per-call event timeline.
- **Easy to extend.** Every STT, TTS, LLM, carrier and agent tool is a registry entry. Adding a new provider is one file.

## How it works

```
POST /v1/calls ──▶ queue ──▶ worker dials ──▶ carrier (Plivo / Twilio)
                                                  │
                         caller's voice ◀──▶ STT ─▶ LLM (+ tools) ─▶ TTS
                                                  │
           webhooks · transcript · outcome ◀──────┘
```

1. Register your provider keys as **connections**.
2. Define an **agent**: instructions, voice, model, and which connections it uses.
3. `POST /v1/calls` with a phone number and some context. A worker dials, the agent talks, and you get webhooks as the call moves from `queued` to `completed`.

## Quickstart: talk to an agent in your browser

You don't need a phone number or a carrier for this. The dev playground runs the same pipeline over WebRTC from your browser.

**You need:** Python 3.13, Docker (for Postgres), and API keys for [Deepgram](https://deepgram.com), [Cartesia](https://cartesia.ai) and [Groq](https://console.groq.com). All three have free tiers.

```bash
git clone https://github.com/welldunai/offhook.git && cd offhook
uv venv && source .venv/bin/activate
uv pip install -e .
cp .env.example .env
```

In `.env`, set `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `GROQ_API_KEY`, and a master encryption key:

```bash
python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"   # → MASTER_ENCRYPTION_KEY
```

Then start Postgres, run migrations, and create a dev tenant with a demo agent:

```bash
docker compose up -d
alembic upgrade head
python -m app.admin seed-dev --voice-id 05a69c2d-457a-4802-8f91-628cb158b522
```

`seed-dev` prints an API key (shown once) and a `DEV_AGENT_ID`. Add `DEV_AGENT_ID` to `.env`, then:

```bash
python run.py
```

Open **http://localhost:8000**, allow the microphone, and start talking. The playground shows live transcripts and per-stage latency.

## Your first phone call

Phone calls need a [Plivo](https://www.plivo.com) or [Twilio](https://www.twilio.com) account and a URL the carrier can reach (for local work, `ngrok http 8000`). Add `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_FROM_NUMBER` and `PUBLIC_BASE_URL` to `.env` before running `seed-dev`, then start the worker next to the API. (`seed-dev` imports Plivo keys from `.env`; for Twilio, add a telephony connection through `POST /v1/connections`, described in [REFERENCE.md](REFERENCE.md).)

```bash
python -m app.worker
```

```bash
curl -X POST localhost:8000/v1/calls \
  -H "Authorization: Bearer $OFFHOOK_KEY" \
  -H "Idempotency-Key: first-call" \
  -H "content-type: application/json" \
  -d '{
    "agent_id": "<DEV_AGENT_ID>",
    "to_number": "+14155550123",
    "context": {"customer_name": "Priya", "appointment_time": "Tuesday at 3 PM"}
  }'
```

Everything in `context` is placed in the agent's prompt, so it can use those facts during the call. Follow the call with `GET /v1/calls/{id}`, its timeline at `/events`, and the conversation at `/transcript`.

## What's inside

| | |
| --- | --- |
| **Calls** | Outbound and inbound, async dial queue, idempotency keys, `queued → dialing → in_progress → completed / failed` |
| **Agents** | Instructions, first message, voice and model per agent; built-in `record_result` and `end_call` tools; your own HTTP tools |
| **Providers** | STT: Deepgram · TTS: Cartesia, OpenAI · LLM: Groq, Gemini, OpenAI, OpenRouter · Carriers: Plivo, Twilio |
| **Observability** | Per-call event timeline, transcripts, stable error codes, activity feed, stats, usage metering |
| **Security** | argon2id API keys, AES-GCM envelope encryption (env or AWS KMS master key), signed webhooks, SSRF guard, log redaction, optional Postgres RLS |
| **Apps** | `dashboard/` console (Clerk sign-in), `docs/` API reference site |

The full API, configuration and internals are in [REFERENCE.md](REFERENCE.md). [ARCHITECTURE.md](ARCHITECTURE.md) explains the design, and [RAILWAY.md](RAILWAY.md) covers deploying to Railway.

## Tests

```bash
uv pip install -e ".[test]"
createdb -O voice voice_test   # one-time; tests use their own database
pytest
```

See [TESTING.md](TESTING.md) for the dashboard tests and more detail.

## Contributing

Issues and pull requests are welcome. Good places to start:

- **A new carrier** (Telnyx, Vonage): subclass `TelephonyProvider` in `app/telephony/`.
- **A new STT, TTS or LLM provider**: add a factory in `app/providers/`.
- **Latency work**: anything that shortens the gap before the agent starts replying.

Look for issues labelled `good first issue`, or open one to talk through an idea before building it.

## License

[Apache-2.0](LICENSE)
