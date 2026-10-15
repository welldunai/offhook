import { Link } from "react-router-dom";
import { Code, Callout } from "../components";

export default function SelfHosting() {
  return (
    <>
      <div className="eyebrow">Self-hosting</div>
      <h1>Overview</h1>
      <p className="lead">
        Offhook is a self-contained backend you can run on your own infrastructure.
        It is three long-running pieces — an API, a worker, and Postgres — plus two
        optional static front-ends. This page explains what you run and why; the
        <Link to="/deploying"> Deploying</Link> and
        <Link to="/configuration"> Configuration</Link> pages are the step-by-step.
      </p>

      <h2 id="components">What you run</h2>
      <table className="ptable">
        <thead><tr><th style={{ width: "22%" }}>Component</th><th style={{ width: "30%" }}>Command</th><th>Role</th></tr></thead>
        <tbody>
          <tr>
            <td><span className="pname">API</span><span className="req">required</span></td>
            <td><span className="ptype">uvicorn app.main:app</span></td>
            <td>Serves the <code>/v1</code> REST API and the carrier webhook + media-stream endpoints. Stateless — scale horizontally behind a load balancer.</td>
          </tr>
          <tr>
            <td><span className="pname">Worker</span><span className="req">required</span></td>
            <td><span className="ptype">python -m app.worker</span></td>
            <td>Drains the dial queue and delivers webhooks. Without it, calls never leave <code>queued</code>. Run one or more; claims use <code>FOR UPDATE SKIP LOCKED</code>, so they are safe in parallel.</td>
          </tr>
          <tr>
            <td><span className="pname">Postgres</span><span className="req">required</span></td>
            <td><span className="ptype">postgres:16</span></td>
            <td>The only datastore — tenants, encrypted connections, agents, calls, the job queue, usage, and the event log all live here. No Redis or external broker needed.</td>
          </tr>
          <tr>
            <td><span className="pname">Dashboard</span><span className="opt">optional</span></td>
            <td><span className="ptype">static (Vite build)</span></td>
            <td>The Offhook Console UI. Build to static files and serve from any CDN/host. Needs Clerk for sign-in.</td>
          </tr>
          <tr>
            <td><span className="pname">Docs</span><span className="opt">optional</span></td>
            <td><span className="ptype">static (Vite build)</span></td>
            <td>This documentation site. Static SPA; serve with an <code>index.html</code> fallback.</td>
          </tr>
        </tbody>
      </table>

      <Callout kind="note">
        The API and worker are <strong>separate processes that each read configuration
        at startup</strong>. They share nothing but the database. When you change
        configuration, restart both.
      </Callout>

      <h2 id="architecture">How a call flows</h2>
      <p>
        A call is fully asynchronous, which is why the worker is mandatory:
      </p>
      <Code tabs={[{ label: "Flow", lang: "text", code: `client ──POST /v1/calls──▶  API  ──enqueue──▶  Postgres (call_jobs)
                                                   │
                            worker ──claim job────▶─┘
                              │
                              ├─ decrypt the tenant's connection secrets
                              ├─ dial via the carrier (Plivo / Twilio)
                              └─ carrier answers ──▶ webhook to PUBLIC_BASE_URL
                                                       │
                          API media-stream WebSocket ◀─┘
                              │
                              └─ STT ─▶ LLM ─▶ TTS  (per-call pipeline)` }]} />
      <p>
        Two consequences for deployment: the worker needs outbound network access to
        the carrier and providers, and <code>PUBLIC_BASE_URL</code> must be an
        externally reachable HTTPS address the carrier can call back on (see
        <Link to="/configuration"> Configuration</Link>).
      </p>

      <h2 id="prerequisites">Prerequisites</h2>
      <ul>
        <li><strong>Python 3.13+</strong> on the API and worker hosts (or one container image used for both).</li>
        <li><strong>Postgres 14+</strong> (the project is tested on 16) reachable from both.</li>
        <li><strong>A master encryption key</strong> — 32 random bytes, base64-encoded — held <em>outside</em> the database. Lose it and every stored provider secret is unrecoverable. Use a secrets manager or KMS.</li>
        <li><strong>A public HTTPS endpoint</strong> for the API if you place real phone calls — a domain with TLS pointing at the API, used for carrier callbacks.</li>
        <li><strong>Provider accounts</strong> for the legs you use (Deepgram, Cartesia, an LLM, and a carrier). These are stored per-tenant via <Link to="/connections">connections</Link>, not in server config.</li>
      </ul>

      <Callout kind="tip">
        Credentials are bring-your-own and live encrypted in the database, never in
        server environment variables at run time. The server only holds operational
        config (database URL, master key, public URL). See
        <Link to="/configuration"> Configuration</Link> for the full list.
      </Callout>

      <p>
        Ready to deploy? Continue to <Link to="/deploying">Deploying</Link>.
      </p>
    </>
  );
}
