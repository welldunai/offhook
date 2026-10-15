import { Link } from "react-router-dom";
import { Code, Callout } from "../components";

export default function Deploying() {
  return (
    <>
      <div className="eyebrow">Self-hosting</div>
      <h1>Deploying</h1>
      <p className="lead">
        A concrete path to a running self-hosted deployment: build one image, run the
        API and worker from it against Postgres, apply migrations, bootstrap a tenant,
        and put TLS in front. Docker Compose and systemd recipes are both below.
      </p>

      <h2 id="image">1. Build an image</h2>
      <p>The same image runs both the API and the worker — they only differ by command.</p>
      <Code tabs={[{ label: "Dockerfile", lang: "text", code: `FROM python:3.13-slim
WORKDIR /app

COPY pyproject.toml README.md ./
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

RUN pip install --no-cache-dir -e .

EXPOSE 8000
# Default command runs the API; the worker overrides it (see compose).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]` }]} />

      <h2 id="compose">2. Run the stack</h2>
      <p>
        A minimal production Compose file: Postgres, the API, and a worker. Put your
        production settings in <code>.env</code> (see <Link to="/configuration">Configuration</Link>)
        — both app services load it.
      </p>
      <Code tabs={[{ label: "docker-compose.yml", lang: "text", code: `services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: voice
      POSTGRES_PASSWORD: change-me-to-a-strong-password
      POSTGRES_DB: voice
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U voice"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build: .
    env_file: .env
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000

  worker:
    build: .
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
    command: python -m app.worker

volumes:
  pgdata:` }]} />
      <Callout kind="warn">
        Point <code>DATABASE_URL</code> at the <code>postgres</code> service host, e.g.
        <code> postgresql+asyncpg://voice:…@postgres:5432/voice</code> — not
        <code> localhost</code>, which inside a container is the container itself.
      </Callout>

      <h2 id="migrations">3. Apply migrations</h2>
      <p>
        Migrations are <strong>not</strong> run at app boot — run them explicitly on
        deploy (and on every upgrade) as a one-off task before starting traffic.
      </p>
      <Code tabs={[{ label: "Terminal", lang: "bash", code: `docker compose run --rm api alembic upgrade head` }]} />

      <h2 id="bootstrap">4. Bootstrap the first tenant</h2>
      <p>
        Creating connections via the API needs an API key, but you have none yet. The
        admin CLI resolves that chicken-and-egg: <code>create-tenant</code> mints the
        first tenant and key.
      </p>
      <Code tabs={[{ label: "Terminal", lang: "bash", code: `docker compose run --rm api python -m app.admin create-tenant \\
  --name "Acme" --slug acme
# prints an API key — shown ONCE. Store it in your secrets manager.` }]} />
      <p>
        From there, register <Link to="/connections">connections</Link> and
        <Link to="/agents"> agents</Link> over the API. (<code>seed-dev</code> exists
        too, but it imports provider keys from the environment and is meant for local
        development, not production.)
      </p>

      <h2 id="proxy">5. TLS &amp; reverse proxy</h2>
      <p>
        Terminate TLS in front of the API and forward to it. The media stream is a
        WebSocket, so the proxy must allow connection upgrades on
        <code> /v1/telephony/stream</code>. Set <code>PUBLIC_BASE_URL</code> to this
        public HTTPS origin — carriers fetch the answer webhook from it.
      </p>
      <Code tabs={[{ label: "nginx", lang: "text", code: `map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name api.your-domain.com;

  # ssl_certificate / ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket upgrade for the carrier media stream
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 3600s;
  }
}` }]} />
      <Callout kind="note">
        The app derives callback URLs from <code>PUBLIC_BASE_URL</code>, not from
        request headers, so a misconfigured <code>X-Forwarded-Host</code> can't
        redirect carrier traffic. Just make sure <code>PUBLIC_BASE_URL</code> matches
        the real public origin.
      </Callout>

      <h2 id="systemd">Alternative: systemd (no Docker)</h2>
      <p>Install the package into a virtualenv, then run two units from it.</p>
      <Code tabs={[{ label: "offhook-api.service", lang: "text", code: `[Unit]
Description=Offhook API
After=network.target

[Service]
WorkingDirectory=/opt/offhook
EnvironmentFile=/opt/offhook/.env
ExecStart=/opt/offhook/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
User=offhook

[Install]
WantedBy=multi-user.target` }, { label: "offhook-worker.service", lang: "text", code: `[Unit]
Description=Offhook dial/webhook worker
After=network.target

[Service]
WorkingDirectory=/opt/offhook
EnvironmentFile=/opt/offhook/.env
ExecStart=/opt/offhook/.venv/bin/python -m app.worker
# The worker drains in-flight jobs on SIGTERM; give it time.
TimeoutStopSec=45
Restart=always
User=offhook

[Install]
WantedBy=multi-user.target` }]} />

      <h2 id="scaling">Scaling &amp; rollout</h2>
      <ul>
        <li><strong>API:</strong> stateless — run multiple replicas behind the load balancer. Add uvicorn workers with <code>--workers N</code> or run more containers.</li>
        <li><strong>Worker:</strong> run several for throughput. Job claims use <code>FOR UPDATE SKIP LOCKED</code>, so they never double-dial; a per-carrier circuit breaker and exponential backoff are built in.</li>
        <li><strong>Graceful shutdown:</strong> workers finish in-flight jobs on <code>SIGTERM</code> — allow ~30–45s before <code>SIGKILL</code> (the systemd unit above sets this).</li>
        <li><strong>Upgrades:</strong> run <code>alembic upgrade head</code> once, then roll the API and worker. Keep migrations backward-compatible for zero-downtime.</li>
      </ul>

      <h2 id="health">Health checks</h2>
      <p>Wire these into your load balancer and orchestrator probes:</p>
      <Code tabs={[{ label: "Terminal", lang: "bash", code: `curl https://api.your-domain.com/healthz
# {"status":"ok"}                       liveness — process is up

curl https://api.your-domain.com/readyz
# {"status":"ready","checks":{          readiness — gate traffic on this
#   "database":"ok",                    DB reachable
#   "migrations":"ok",                  schema at head revision
#   "master_key":"ok"}}                 master key present and usable` }]} />
      <Callout kind="tip">
        Use <code>/readyz</code> as the readiness gate — it returns non-ready (503)
        when the database is down, migrations are behind, or the master key is missing,
        so a half-configured instance never receives traffic.
      </Callout>

      <p>
        Next: lock down <Link to="/configuration">Configuration</Link> for production —
        required variables, the master key, KMS, and row-level security.
      </p>
    </>
  );
}
