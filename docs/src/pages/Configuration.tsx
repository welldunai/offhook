import { Link } from "react-router-dom";
import { Code, Callout, Params } from "../components";

export default function Configuration() {
  return (
    <>
      <div className="eyebrow">Self-hosting</div>
      <h1>Configuration</h1>
      <p className="lead">
        All server configuration is environment variables, validated once at startup —
        a malformed or missing required value fails fast rather than at the first call.
        Per-tenant provider credentials are <strong>not</strong> here; they live
        encrypted in the database. Set these on both the API and the worker.
      </p>

      <h2 id="core">Core</h2>
      <Params title="Environment" rows={[
        { name: "ENV", type: "dev | prod", required: true, desc: <>Run mode. <code>prod</code> turns on the strict checks below and disables dev affordances.</> },
        { name: "DATABASE_URL", type: "string", required: true, desc: <>Async SQLAlchemy DSN, e.g. <code>postgresql+asyncpg://voice:…@host:5432/voice</code>. Must use the <code>+asyncpg</code> driver.</> },
        { name: "PUBLIC_BASE_URL", type: "url", required: true, desc: <>External HTTPS origin carriers call back on (answer webhook + media stream). Required in <code>prod</code>. Derived callbacks never trust request headers.</> },
        { name: "LOG_LEVEL", type: "string", desc: <>Python log level. Use <code>INFO</code> or <code>WARNING</code> in production.</> },
        { name: "RECORDINGS_DIR", type: "string", desc: <>Where call audio is written on local disk (default <code>recordings</code>). Back it with a mounted volume or object storage.</> },
      ]} />

      <h2 id="encryption">Encryption &amp; key management</h2>
      <p>
        Tenant secrets are sealed with envelope encryption: a per-tenant data key
        (DEK) encrypts the secrets, and a <em>master key</em> wraps the DEKs. The
        master key lives outside the database.
      </p>
      <Params title="Keys" rows={[
        { name: "MASTER_ENCRYPTION_KEY", type: "base64", required: true, desc: <>The active master key — base64 of exactly 32 random bytes. Required in <code>prod</code>. <strong>Lose it and every stored secret is unrecoverable.</strong></> },
        { name: "MASTER_KEY_ID", type: "string", desc: <>Identifier recorded on each wrapped DEK (default <code>v1</code>). Lets retired keys stay available for unwrap during rotation.</> },
        { name: "KEY_PROVIDER", type: "env | kms", desc: <>Where the master key comes from. <code>env</code> reads <code>MASTER_ENCRYPTION_KEY</code>; <code>kms</code> wraps DEKs with AWS KMS instead.</> },
        { name: "KMS_KEY_ID", type: "string", desc: <>The KMS key ARN/ID, required when <code>KEY_PROVIDER=kms</code>. boto3 is lazy-loaded.</> },
      ]} />
      <p>Generate a master key:</p>
      <Code tabs={[{ label: "Terminal", lang: "bash", code: `python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"` }]} />
      <Callout kind="warn">
        Keep the master key in a secrets manager (or use <code>KEY_PROVIDER=kms</code>),
        never in source control. To rotate, add the new key as
        <code> MASTER_ENCRYPTION_KEY</code>, bump <code>MASTER_KEY_ID</code>, and keep the
        old one available as <code>MASTER_ENCRYPTION_KEY_&lt;old-id&gt;</code> so existing
        DEKs still unwrap.
      </Callout>

      <h2 id="rls">Row-level security (optional)</h2>
      <p>
        The repository layer already scopes every query by tenant. Postgres RLS is a
        second wall so a missed <code>WHERE</code> can't leak across tenants. It is off
        by default because it needs a two-role database setup.
      </p>
      <Params title="RLS" rows={[
        { name: "ENABLE_RLS", type: "bool", desc: <>Turn on per-transaction tenant scoping (<code>app.current_tenant</code>). Apply <code>app/db/rls.sql</code> first.</> },
      ]} />
      <p>
        The API connects as a non-owner role with DML grants (RLS applies); the worker
        and carrier paths connect as a <code>BYPASSRLS</code> role, since they look up
        rows by job or token before a tenant is known. The full role setup is documented
        at the top of <code>app/db/rls.sql</code>.
      </p>

      <h2 id="dashboard">Dashboard auth &amp; CORS</h2>
      <p>Only needed if you host the Offhook Console UI.</p>
      <Params title="Dashboard" rows={[
        { name: "CLERK_ISSUER", type: "url", desc: <>Issuer of the Clerk session JWTs the dashboard sends, e.g. <code>https://your-app.clerk.accounts.dev</code>. The API verifies tokens against its JWKS.</> },
        { name: "CLERK_JWKS_URL", type: "url", desc: <>Override the JWKS endpoint; derived from the issuer if unset.</> },
        { name: "CORS_ORIGINS", type: "csv", desc: <>Comma-separated browser origins allowed to call the API. Set this to your dashboard's deployed origin in production (the default only covers local Vite ports).</> },
      ]} />

      <h2 id="dev-only">Dev-only flags</h2>
      <p>These exist for local development and are rejected (or should be off) in <code>prod</code>.</p>
      <Params title="Development" rows={[
        { name: "ENABLE_PREBUILT_UI", type: "bool", desc: <>Mounts the prebuilt mic-call playground, which starts <em>unauthenticated</em> default-agent calls. <strong>Must be false in prod</strong> — boot fails otherwise.</> },
        { name: "WEBHOOK_ALLOW_PRIVATE", type: "bool", desc: <>Allows webhook delivery to private/loopback hosts. <strong>Must be false in prod</strong> — it bypasses the SSRF guard. Boot fails otherwise.</> },
        { name: "DEV_AGENT_ID", type: "uuid", desc: <>Which agent the playground calls. Ignored when the playground is off.</> },
      ]} />

      <h2 id="checklist">Production checklist</h2>
      <p>With <code>ENV=prod</code>, startup hard-fails unless all of these hold:</p>
      <Code tabs={[{ label: ".env (prod)", lang: "bash", code: `ENV=prod
DATABASE_URL=postgresql+asyncpg://voice_api:…@db:5432/voice
PUBLIC_BASE_URL=https://api.your-domain.com    # required in prod
MASTER_ENCRYPTION_KEY=…                         # required in prod (or KEY_PROVIDER=kms)
ENABLE_PREBUILT_UI=false                        # enforced false in prod
WEBHOOK_ALLOW_PRIVATE=false                     # enforced false in prod
LOG_LEVEL=INFO
CORS_ORIGINS=https://console.your-domain.com` }]} />
      <ul>
        <li>✅ <strong>Master key</strong> stored in a secrets manager or KMS — not on the host, not in git.</li>
        <li>✅ <strong>TLS</strong> in front of the API; <code>PUBLIC_BASE_URL</code> matches the public HTTPS origin.</li>
        <li>✅ <strong>Migrations</strong> applied (<code>alembic upgrade head</code>) — confirm via <code>/readyz</code>.</li>
        <li>✅ <strong>Postgres backups</strong> + a tested restore. The database holds every encrypted secret and all call history.</li>
        <li>✅ <strong>CORS</strong> narrowed to your real dashboard origin.</li>
        <li>✅ <strong>Worker</strong> running (calls stay <code>queued</code> without it) with graceful-shutdown time configured.</li>
        <li>✅ Optional: <code>ENABLE_RLS=1</code> with the two-role setup for defense-in-depth.</li>
      </ul>

      <Callout kind="note">
        Back up the master key and the database <em>together</em> and treat them with the
        same care — a database backup without the master key is unreadable, and the master
        key without the database is useless. That separation is the point of envelope
        encryption.
      </Callout>

      <p>
        Operational runbook and troubleshooting live alongside the code in
        <code> RUNNING.md</code>. For the API surface, see the
        <Link to="/"> reference</Link>.
      </p>
    </>
  );
}
