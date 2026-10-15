import { Code, Callout, Endpoint, Params } from "../components";

const EVENTS: [string, string, string][] = [
  ["call.queued", "var(--slate)", "Call accepted and queued to dial."],
  ["call.dialing", "var(--amber)", "The carrier is dialing the number."],
  ["call.in_progress", "var(--amber)", "Connected — the conversation is live."],
  ["call.completed", "var(--pine)", "Ended normally. Includes outcome + transcript."],
  ["call.failed", "var(--rust)", "Ended in error. Includes an error_code."],
  ["call.received", "var(--slate)", "An inbound call arrived on one of your numbers."],
  ["carrier.hangup", "var(--ink-3)", "The carrier reported a hangup cause (busy, no-answer…)."],
];

export default function Webhooks() {
  return (
    <>
      <div className="eyebrow">Events &amp; logs</div>
      <h1>Webhooks</h1>
      <p className="lead">
        Receive a signed HTTP callback for every call event, instead of polling.
        Deliveries are retried with exponential backoff until they succeed.
      </p>

      <h2 id="register">Register an endpoint</h2>
      <Endpoint method="POST" path="/v1/webhooks" />
      <Params rows={[
        { name: "url", type: "string", required: true, desc: "Public https URL to receive POSTs. Validated for SSRF at write time." },
        { name: "events", type: "string[]", desc: "Event types to subscribe to. Empty = all events." },
      ]} />
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/webhooks \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "url": "https://you.example.com/hook", "events": [] }'` }, { label: "Response", lang: "json", code: `{
  "id": "whk_…",
  "url": "https://you.example.com/hook",
  "events": [],
  "enabled": true,
  "secret": "whsec_…"
}` }]} />
      <Callout kind="warn">
        The <code>secret</code> is returned once. Use it to verify signatures (below).
      </Callout>

      <h2 id="events">Event types</h2>
      <div className="status-list">
        {EVENTS.map(([ev, c, d]) => (
          <div className="status-row" key={ev}>
            <span className="ev" style={{ color: c }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9, background: c, marginRight: 8 }} />{ev}</span>
            <span style={{ color: "var(--ink-2)" }}>{d}</span>
          </div>
        ))}
      </div>

      <h2 id="payload">Payload</h2>
      <p>Each delivery is a POST with this JSON body and these headers:</p>
      <Code tabs={[{ label: "Body", lang: "json", code: `{
  "id": "evt_…",
  "event": "call.completed",
  "created": 1750412445,
  "data": {
    "call_id": "call_8f2c…",
    "status": "completed",
    "summary": "Confirmed for Tuesday 3 PM",
    "duration_seconds": 38
  }
}` }, { label: "Headers", lang: "text", code: `X-Voice-Event:     call.completed
X-Voice-Delivery:  evt_…
X-Voice-Signature: t=1750412445,v1=4f1c…` }]} />

      <h2 id="verify">Verify the signature</h2>
      <p>
        The <code>X-Voice-Signature</code> header is <code>t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>,
        where the HMAC is SHA-256 of <code>"&#123;t&#125;.&#123;raw_body&#125;"</code> keyed
        with your endpoint secret. Recompute it and compare in constant time; reject
        stale timestamps to prevent replay.
      </p>
      <Code tabs={[
        { label: "Python", lang: "text", code: `import hmac, hashlib, time

def verify(secret, body, header, tolerance=300):
    parts = dict(p.split("=", 1) for p in header.split(","))
    t, v1 = int(parts["t"]), parts["v1"]
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.{body}".encode(),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)` },
        { label: "Node", lang: "text", code: `import crypto from "node:crypto";

function verify(secret, body, header, tolerance = 300) {
  const p = Object.fromEntries(header.split(",").map(s => s.split("=")));
  const t = Number(p.t);
  if (Math.abs(Date.now() / 1000 - t) > tolerance) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(\`\${t}.\${body}\`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(p.v1));
}` },
      ]} />
      <Callout kind="note">Verify against the <strong>raw</strong> request body, before any JSON re-serialization.</Callout>

      <h2 id="manage">List &amp; delete</h2>
      <Endpoint method="GET" path="/v1/webhooks" />
      <Endpoint method="DELETE" path="/v1/webhooks/{id}" />
    </>
  );
}
