import { Link } from "react-router-dom";
import { Code, Callout, Endpoint, Params } from "../components";

export default function Inbound() {
  return (
    <>
      <div className="eyebrow">Events &amp; logs</div>
      <h1>Inbound calls</h1>
      <p className="lead">
        Route an incoming phone number to one of your agents. Inbound calls run
        the same pipeline and produce the same events, transcript, and logs as
        outbound calls.
      </p>

      <h2 id="how">How it works</h2>
      <ol>
        <li>Map a number to an agent with <code>POST /v1/phone-numbers</code>.</li>
        <li>Point that number's <strong>answer URL</strong> (at your carrier) to <code>https://&lt;your-host&gt;/v1/telephony/inbound</code>.</li>
        <li>When a call arrives, Offhook matches the dialed number to its agent, verifies the carrier signature, and connects the call.</li>
      </ol>
      <Callout kind="note">
        The inbound webhook is carrier-facing and authenticated by the provider's
        signature — it is not part of the tenant API and needs no key.
      </Callout>

      <h2 id="map">Map a number</h2>
      <Endpoint method="POST" path="/v1/phone-numbers" />
      <Params rows={[
        { name: "e164", type: "string", required: true, desc: "The number in E.164 format, e.g. +14155550123." },
        { name: "agent_id", type: "string", required: true, desc: "The agent that answers calls to this number." },
      ]} />
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/phone-numbers \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "e164": "+14155550123", "agent_id": "agt_…" }'` }, { label: "Response", lang: "json", code: `{
  "id": "pn_…",
  "e164": "+14155550123",
  "agent_id": "agt_…",
  "created_at": "2026-06-20T10:00:00Z"
}` }]} />

      <h2 id="manage">List &amp; delete</h2>
      <Endpoint method="GET" path="/v1/phone-numbers" />
      <Endpoint method="DELETE" path="/v1/phone-numbers/{id}" />
      <p>
        Inbound calls show up in your activity feed with <code>direction: "inbound"</code>
        and emit a <Link to="/webhooks"><code>call.received</code></Link> event.
      </p>
    </>
  );
}
