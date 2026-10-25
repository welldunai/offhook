# Testing

Runnable test suites for the backend (pytest) and the dashboard frontend
(Vitest). 123 tests total: 109 backend, 14 frontend.

## Backend (pytest)

Needs a Postgres test database named `voice_test` (separate from the dev `voice`
db). The harness binds to it and the master key via env set in `tests/conftest.py`
*before* the app imports, so it never touches your dev data.

```bash
source .venv/bin/activate
uv pip install -e '.[test]'          # pytest + pytest-asyncio
createdb -O voice voice_test         # one-time
python -m pytest -q
```

The schema is built from the SQLAlchemy models (`Base.metadata.create_all`) and
every test starts from a truncated database, so runs are isolated and order-
independent.

### Fixtures (`tests/conftest.py`)
- `client` — `httpx.AsyncClient` over the ASGI app with tenant auth + rate limit
  overridden (the common case).
- `raw_client` — same app with **no** overrides, for the real auth/ratelimit path.
- `session` — committed `AsyncSession` for arranging data.
- `tenant`, `api_key` — a seeded tenant and a real API key.
- `make_connection`, `make_full_agent` — helpers that create encrypted
  connections and a fully-wired agent.

### Coverage
| File | Area |
| --- | --- |
| `test_crypto.py` | envelope encryption: roundtrip, AAD row-binding, tamper detection |
| `test_keyprovider.py` | master-key wrap/unwrap, rotation, unknown-key errors |
| `test_apikey.py` | argon2 key gen / parse / verify |
| `test_ssrf.py` | URL guard: private/loopback/metadata/CGNAT blocked, scheme + creds |
| `test_redaction.py` | log scrubbing of bearer/api-key/secret patterns |
| `test_signing.py` | webhook HMAC sign/verify, stale + malformed headers |
| `test_settings.py` | prod fail-fast guards, master-key validation, CORS parsing |
| `test_schemas.py` | `CallCreate` tag/number validation |
| `test_config.py` | `ResolvedCreds.secret/setting` (the provider-factory seam) |
| `test_auth.py` | API-key auth, revocation, header forms, cross-tenant isolation |
| `test_connections_api.py` | CRUD, provider validation, write-only secrets, dupes |
| `test_agents_api.py` | CRUD, connection-reference validation |
| `test_calls_api.py` | create + tags, idempotency, concurrent + monthly quotas |
| `test_activity_tags.py` | activity filters, **tag search** (single/AND/malformed), pagination, stats |
| `test_repositories.py` | tenant scoping, call counters, session-token lookup |
| `test_tenancy_resolve.py` | `prepare_call` → VoiceConfig, credential-sourced voice_id |
| `test_ratelimit.py` | fixed-window counter, per-tenant isolation |
| `test_webhooks_api.py` | registration, secret-shown-once, SSRF rejection |

## Frontend (Vitest + Testing Library)

```bash
cd dashboard
npm install            # devDeps include vitest, jsdom, @testing-library/*
npm test               # vitest run   (npm run test:watch for watch mode)
```

| File | Area |
| --- | --- |
| `src/api.test.ts` | API client: query building incl. repeatable `tag=` params, `createCall` body, `ApiError` |
| `src/pages/Calls.test.tsx` | Calls page: render, tag add/remove (input + row chip), status dropdown filter, pagination, initial fetch params |

The component test mocks `../api` and renders the page inside a `MemoryRouter`;
the real `useAsync` hook drives the mocked client so the filter/pagination wiring
is exercised end to end.

## Live demo

- Worker: `cd demo/worker && nvm use && pnpm test` (Vitest, in Node; the Gate's logic runs on `node:sqlite`).
- Voice server: `python -m pytest tests/demo` (no database needed).
- In a browser, end to end: `python demo/e2e/browser_call.py`, with the local servers from [demo/README.md](demo/README.md) running.
