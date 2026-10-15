import { Code, Callout } from "../components";

const HTTP: [string, string][] = [
  ["200 / 201", "Success."],
  ["204", "Success, no content (deletes)."],
  ["401", "Missing or invalid API key."],
  ["403", "Tenant suspended, or carrier-endpoint auth failed."],
  ["404", "Resource not found (and not yours)."],
  ["409", "Conflict — e.g. a connection still in use, or an idempotency-key reuse with a different body."],
  ["422", "Validation error — bad or missing fields."],
  ["429", "Rate limit or quota exceeded. Honor Retry-After."],
  ["502", "Upstream carrier/provider error while placing a call."],
];

const CODES: [string, string][] = [
  ["carrier_unauthorized", "The telephony credentials were rejected by the carrier."],
  ["carrier_error", "The carrier returned an error while dialing."],
  ["busy", "The line was busy."],
  ["no_answer", "The callee didn't answer (or timed out)."],
  ["rejected", "The call was rejected."],
  ["invalid_number", "The destination number is unallocated / invalid."],
  ["config_error", "An agent connection was missing or invalid at dial time."],
  ["provider_timeout", "An STT/TTS/LLM provider timed out."],
  ["pipeline_error", "The conversation pipeline crashed mid-call."],
];

export default function Errors() {
  return (
    <>
      <div className="eyebrow">Reference</div>
      <h1>Errors &amp; limits</h1>
      <p className="lead">
        Offhook uses conventional HTTP status codes. Error responses carry a
        human-readable <code>detail</code>; failed calls carry a stable <code>error_code</code>.
      </p>

      <Code tabs={[{ label: "Error response", lang: "json", code: `{ "detail": "agent not found" }` }]} />

      <h2 id="http">HTTP status codes</h2>
      <table className="ptable">
        <thead><tr><th style={{ width: "22%" }}>Status</th><th>Meaning</th></tr></thead>
        <tbody>{HTTP.map(([s, d]) => <tr key={s}><td className="pname">{s}</td><td>{d}</td></tr>)}</tbody>
      </table>

      <h2 id="codes">Call error codes</h2>
      <p>When a call ends in <code>failed</code>, its <code>error_code</code> (on the call and on the <code>call.failed</code> event) is one of:</p>
      <table className="ptable">
        <thead><tr><th style={{ width: "30%" }}>Code</th><th>Meaning</th></tr></thead>
        <tbody>{CODES.map(([c, d]) => <tr key={c}><td className="pname">{c}</td><td>{d}</td></tr>)}</tbody>
      </table>

      <h2 id="rate-limits">Rate limits</h2>
      <p>
        Requests are rate-limited per tenant (a fixed per-minute budget). Over the
        limit, the API returns <code>429</code> with a <code>Retry-After</code> header.
        Back off and retry.
      </p>

      <h2 id="quotas">Call quotas</h2>
      <p><code>POST /v1/calls</code> is additionally bounded by two quotas:</p>
      <ul>
        <li><strong>Concurrency</strong> — a cap on simultaneous live calls.</li>
        <li><strong>Monthly cap</strong> — an optional ceiling on calls per calendar month.</li>
      </ul>
      <p>Exceeding either returns <code>429</code> with a descriptive <code>detail</code>.</p>

      <h2 id="idempotency">Idempotency</h2>
      <p>
        Send an <code>Idempotency-Key</code> header on <code>POST /v1/calls</code> to make
        retries safe. The first request is processed and its response cached;
        replays with the same key return that cached response instead of placing a
        second call.
      </p>
      <Callout kind="note">
        Reusing a key with a <em>different</em> request body returns <code>409</code>.
      </Callout>
    </>
  );
}
