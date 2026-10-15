import { Code, Callout, Endpoint, Params } from "../components";

export default function Authentication() {
  return (
    <>
      <div className="eyebrow">Getting started</div>
      <h1>Authentication</h1>
      <p className="lead">
        Two ways in: humans sign in to the <strong>dashboard</strong>; machines call the
        <strong> API</strong> with a key. Both resolve to the same workspace (tenant).
      </p>

      <h2 id="dashboard">Dashboard login</h2>
      <p>
        The console uses <a href="https://clerk.com" target="_blank" rel="noreferrer">Clerk</a> for
        user sign-in. Your first login automatically provisions a workspace. From there you
        create API keys for your servers — no key needed to view your own data.
      </p>

      <h2 id="api-keys">API keys</h2>
      <p>For programmatic access, send your key as a bearer token on every request:</p>
      <Code tabs={[{ label: "Header", lang: "bash", code: `Authorization: Bearer vk_live_AB12CD34_…` }]} />

      <p>
        Keys are scoped to a single tenant; all data you create and read belongs
        to that tenant. Keys look like <code>vk_&lt;env&gt;_&lt;prefix&gt;_&lt;secret&gt;</code>.
        The full secret is shown <strong>once</strong> at creation — store it safely.
      </p>

      <Callout kind="warn">
        Keep API keys server-side. They grant full access to your tenant's calls,
        connections, and provider credentials. Never ship a key in a browser or
        mobile app.
      </Callout>

      <h2 id="create">Create a key</h2>
      <Endpoint method="POST" path="/v1/api-keys" />
      <Params rows={[
        { name: "name", type: "string", desc: "A label to recognize the key later." },
        { name: "expires_in_days", type: "int", desc: "Optional. The key stops working after this many days (1–3650). Omit for no expiry." },
      ]} />
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/api-keys \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "production backend" }'` }, { label: "Response", lang: "json", code: `{
  "id": "key_…",
  "prefix": "AB12CD34",
  "key": "vk_live_AB12CD34_…",
  "created_at": "2026-06-20T10:00:00Z"
}` }]} />
      <Callout kind="note">The <code>key</code> field is the only time the full secret is returned.</Callout>

      <h2 id="list">List keys</h2>
      <Endpoint method="GET" path="/v1/api-keys" />
      <p>Returns metadata only (prefix, name, last-used, revoked-at) — never the secret.</p>

      <h2 id="revoke">Revoke a key</h2>
      <Endpoint method="DELETE" path="/v1/api-keys/{id}" />
      <p>Revocation is immediate. Requests using the key are rejected with <code>401</code> from the next call onward.</p>

      <h2 id="errors">Auth errors</h2>
      <ul>
        <li><code>401 Unauthorized</code> — missing, malformed, revoked, or incorrect key.</li>
        <li><code>403 Forbidden</code> — the key's tenant is suspended.</li>
      </ul>
    </>
  );
}
