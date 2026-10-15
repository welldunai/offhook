# Contributing to Offhook

Thanks for helping. Bug reports, fixes, new providers and documentation are all welcome.

## Before you start

- **Small fixes** (typos, docs, obvious bugs): open a pull request directly.
- **Anything bigger** (a new provider, an API change, a new feature): open an issue first so we can agree on the approach before you spend time on it.
- New here? Issues labelled [`good first issue`](https://github.com/welldunai/offhook/labels/good%20first%20issue) are scoped to be done in an afternoon or two.

## Set up

Follow the [README quickstart](README.md#quickstart-talk-to-an-agent-in-your-browser) to run the API and talk to an agent in your browser. [RUNNING.md](RUNNING.md) covers the worker, the dashboard, real phone calls and common failures.

## Run the tests

Backend (needs a separate `voice_test` Postgres database):

```bash
uv pip install -e ".[test]"
createdb -O voice voice_test     # one-time
pytest
```

Dashboard:

```bash
cd dashboard && npm install && npm test && npm run lint
```

See [TESTING.md](TESTING.md) for details. Pull requests should keep all tests passing and add tests for new behaviour.

## Where things go

Everything pluggable is a registry entry: a module that registers itself under a name. You should never need to edit a central `if/elif`.

| To add a… | Do this |
| --- | --- |
| **Telephony carrier** | Add `app/telephony/<carrier>.py` subclassing `TelephonyProvider`, register it with `@telephony_registry.register("<name>")`, import it in `app/telephony/__init__.py`, and add the name to `SUPPORTED_PROVIDERS` in `app/config.py`. `plivo.py` and `twilio.py` are working examples. |
| **STT, TTS or LLM provider** | Add a factory in `app/providers/{stt,tts,llm}.py` that takes `ResolvedCreds`, register it, and add the name to `SUPPORTED_PROVIDERS`. Factories must not read environment variables, because credentials are per tenant. |
| **Built-in agent tool** | Add a `Tool` subclass in `app/tools/builtin.py` and register it with `@tool_registry.register("<name>")`. |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the call lifecycle, the job queue and the encryption design in depth.

## Ground rules

- **Never log or return secrets.** Provider keys are decrypted only for the length of a call. New code that touches credentials must keep it that way; `app/security/redaction.py` scrubs logs.
- **Every call state change goes through `emit_call_event`** so the event timeline and webhooks stay in sync. Don't update call status directly.
- **Latency matters.** If your change touches the live call path (`app/pipeline.py`, `app/runner.py`, providers), say in the pull request how it affects time-to-first-reply.
- **Don't commit `.env`, recordings or logs.** They are already in `.gitignore`.

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and why, and how you tested it. For call-path changes, a short note from a real or playground call helps.
- By contributing, you agree that your contributions are licensed under the [Apache-2.0 license](LICENSE).

## Security issues

Please don't open a public issue for security problems. Report them privately through GitHub's [Report a vulnerability](https://github.com/welldunai/offhook/security/advisories/new) form instead.
