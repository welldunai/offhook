# Deploying offhook on Railway

Three Railway services from this one repo (API, worker, dashboard), sharing a
Postgres database. Config-as-code lives at the repo root
(`railway.api.json`, `railway.worker.json`) and in `dashboard/railway.json`.
Repo: https://github.com/welldunai/offhook

For architecture/env-var reference see `README.md` / `ARCHITECTURE.md`. For
the generic (non-Railway) self-host path see `docs/src/pages/Deploying.tsx`.

## 0. Choose your database

Railway's own Postgres plugin is the path of least resistance, but it's
metered (storage + compute), and it's easy to forget it's running. If you'd
rather not pay Railway for the database, bring your own:

| Option | Cost | Notes |
| --- | --- | --- |
| **Railway Postgres plugin** | Usage-based (see railway.com/pricing) | Zero setup, private-network connection to API/worker (no SSL, no egress fee) |
| **Neon / Supabase (BYO)** | Free tier covers small/hobby usage | External host, requires SSL — see below |
| **Your own existing Postgres** | Whatever you already pay | Same as above — just a `DATABASE_URL` pointed at it |

Both options plug into the exact same `DATABASE_URL` variable on the API and
worker services — nothing else in this guide changes based on which you pick.

**Option A — Railway Postgres plugin:**
In the Railway project, "+ New" → Database → Add PostgreSQL. Then on
**both** the API and worker services, set:

```
DATABASE_URL=postgresql+asyncpg://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
```

(Note the `+asyncpg` — Railway's own `${{Postgres.DATABASE_URL}}` reference is
a plain `postgresql://` URL, which SQLAlchemy will refuse since this app uses
the async driver. Build it from the individual `PG*` vars instead, as above.)
Services in the same project talk to the plugin over Railway's private
network, so no SSL query param is needed.

**Option B — bring your own Postgres (e.g. Neon or Supabase free tier):**
Create the database with that provider, then set the same variable directly
on both services:

```
DATABASE_URL=postgresql+asyncpg://<user>:<password>@<host>/<db>?ssl=require
```

The `?ssl=require` is needed for any external provider that enforces TLS
(Neon and Supabase both do). Use `ssl=require`, not `sslmode=require` —
SQLAlchemy's asyncpg dialect only recognizes the former.

## 1. Create the Railway project and link the repo

```bash
railway login          # opens a browser
railway init            # or: link an existing project with `railway link`
```

Or do this from the Railway dashboard: New Project → Deploy from GitHub repo
→ `welldunai/offhook`. Either way, you'll end up creating three
services against this one repo (next step) rather than deploying the repo
itself as a single service.

## 2. Create the three services

For each, in the service's **Settings**:

| Service | Root directory | Config-as-code path | Builder |
| --- | --- | --- | --- |
| `api` | `/` | `/railway.api.json` | Dockerfile |
| `worker` | `/` | `/railway.worker.json` | Dockerfile |
| `dashboard` | `/dashboard` | `/dashboard/railway.json` | Railpack (Node) |

The config file path is always given **absolute from the repo root**,
regardless of a service's root directory setting — that's a Railway quirk,
not a typo.

`api` and `worker` build from the same root-level `Dockerfile` and differ
only by `startCommand` (see the respective json files) — migrations
(`alembic upgrade head`) run automatically as the API service's
`preDeployCommand`, once per API deploy, before it starts taking traffic.
Don't add the same `preDeployCommand` to the worker service — if both ran it
on every deploy you'd risk two concurrent `alembic upgrade head` runs racing
each other.

## 3. Environment variables

Use Railway's **Shared Variables** (project Settings → Shared Variables) for
everything both `api` and `worker` need, then reference them from each
service (or just tick "share with all services"). This keeps the two in
sync — RUNNING.md's local rule ("restart both after an env change") applies
here too: redeploy both after editing a shared variable.

**Shared by `api` + `worker`:**

```
ENV=prod
DATABASE_URL=...                       # see step 0
MASTER_ENCRYPTION_KEY=...              # same one you already generated locally — reuse it,
                                        # don't regenerate, or existing encrypted secrets become unrecoverable
MASTER_KEY_ID=v1
ENABLE_PREBUILT_UI=0                   # must be 0 in prod — settings.py enforces this at boot
WEBHOOK_ALLOW_PRIVATE=0                # must be 0 in prod
PUBLIC_BASE_URL=https://<api-service>.up.railway.app   # set AFTER generating the api domain (step 4)
CORS_ORIGINS=https://<dashboard-service>.up.railway.app # set AFTER generating the dashboard domain (step 4)
                                        # comma-separate additional origins if you add a custom domain to the
                                        # dashboard later (e.g. ...up.railway.app,https://your-custom-domain) —
                                        # otherwise the dashboard gets CORS errors calling the API from the new origin
VOICE_LLM_PROVIDER=groq
VOICE_LLM_MODEL=llama-3.1-8b-instant
VOICE_STT_PROVIDER=deepgram
VOICE_STT_MODEL=nova-3
VOICE_TTS_PROVIDER=cartesia
VOICE_TTS_MODEL=sonic-3
VOICE_LANGUAGE=en
VOICE_TELEPHONY_PROVIDER=plivo
LOG_LEVEL=INFO
```

Skip `DEEPGRAM_API_KEY` / `CARTESIA_API_KEY` / `GROQ_API_KEY` /
`PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` / `PLIVO_FROM_NUMBER` — per RUNNING.md
these are only read by `app.admin seed-dev`, which is dev-only. In prod, the
first tenant + its connections are created with `app.admin create-tenant`
(step 6) and provider credentials go in via `POST/PATCH /v1/connections`
instead, encrypted at rest — never as env vars.

**API-only:**

```
HOST=0.0.0.0
PORT=8000            # Railway sets $PORT itself; only override if you need a fixed value
```

**Dashboard (build-time — set before the first build, changing them later
needs a redeploy to take effect since Vite bakes them in):**

```
VITE_API_URL=https://<api-service>.up.railway.app
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...    # from your Clerk app
```

Also set `CLERK_ISSUER` (shared var above, API-side) to your Clerk app's
issuer URL if you want dashboard sign-in to work — same value as your local
`dashboard/.env`'s Clerk app, or a separate production Clerk instance.

## 4. Generate domains, then wire URLs together

Order matters here because of the circular reference (API needs to know its
own public URL; dashboard needs to know the API's URL):

1. On the `api` service: Settings → Networking → Generate Domain. Copy it.
2. On the `dashboard` service: Settings → Networking → Generate Domain. Copy it.
3. Set `PUBLIC_BASE_URL` (api+worker) and `CORS_ORIGINS` (api+worker) and
   `VITE_API_URL` (dashboard) using the two domains from steps 1–2.
4. Redeploy all three services so the new variables take effect.

## 5. First deploy: migrate and bootstrap

The API service's `preDeployCommand` handles `alembic upgrade head` on every
deploy going forward. For extra safety on the very first deploy (before
trusting deploy ordering across services), you can also run it by hand:

```bash
railway run --service api alembic upgrade head
```

Then bootstrap the first tenant (prints an API key **once** — save it):

```bash
railway run --service api python -m app.admin create-tenant --name "Acme" --slug acme
```

Register connections (Cartesia/Deepgram/Groq keys, Plivo) and an agent via
`POST /v1/connections` and `/v1/agents` using that API key, or through the
dashboard once it's up.

## 6. Point Plivo at the new URL

Update your Plivo number's answer URL to:
`https://<api-service-domain>/v1/telephony/inbound`

No ngrok in production — `PUBLIC_BASE_URL` is the real Railway domain from
step 4, so there's no stale-tunnel failure mode (RUNNING.md's Playbook A) to
worry about here.

## 7. Optional: persistent recordings

`RECORDINGS_DIR` defaults to local disk (`app/recording.py`), which is
ephemeral on Railway — wiped on every redeploy/restart. Either:

- Attach a Railway **Volume** to `api` and `worker` at the same mount path,
  and set `RECORDINGS_DIR` to that path on both, or
- Swap `save_recording` for object storage (S3/GCS) — not done here, out of
  scope for this deploy pass.

## Sleep on inactivity (cost saving)

All three `railway.*.json` files set `deploy.sleepApplication: true`. Railway
sleeps a service after ~10 minutes with no outbound traffic and wakes it on
the next incoming request — good for `api` and `dashboard`, which have public
domains to receive that wake-up request.

`worker` has **no public domain**, so there's no inbound request to wake it
if it sleeps — it will likely stay asleep until you manually restart it:

```bash
railway redeploy -s offhook-worker
```

If a call ever gets stuck at `dialing` and `PUBLIC_BASE_URL`/ngrok isn't the
cause (Playbook A doesn't apply here — no ngrok in prod), check whether the
worker is asleep before anything else. Set `sleepApplication: false` in
`railway.worker.json` if this bites you.

## Health checks

Both `railway.api.json`'s `healthcheckPath: /healthz` and Railway's deploy
logs are your first signal something's wrong. `/readyz` additionally reports
DB connectivity, migration status, and master-key health — worth checking by
hand after the first deploy:

```bash
curl https://<api-service-domain>/healthz
curl https://<api-service-domain>/readyz
```
