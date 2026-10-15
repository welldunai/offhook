import { Link } from "react-router-dom";
import { Code, Callout } from "../components";

export default function Introduction() {
  return (
    <>
      <div className="eyebrow">Getting started</div>
      <h1>Offhook API</h1>
      <p className="lead">
        A single REST API to place and receive AI voice calls — driven by your own
        speech-to-text, text-to-speech, language, and telephony providers.
      </p>

      <p>
        Offhook handles the hard parts of a production voice agent: low-latency
        media, reliable dialing, a complete audit log, and signed webhooks. You
        bring the provider keys and describe the agent; the API does the rest.
      </p>

      <h2 id="base-url">Base URL</h2>
      <p>All requests are made to your deployment. In local development that is:</p>
      <Code tabs={[{ label: "Base URL", lang: "text", code: "http://localhost:8000" }]} />
      <Callout kind="note">
        Every endpoint in these docs is relative to that base, e.g.{" "}
        <code>POST /v1/calls</code> → <code>http://localhost:8000/v1/calls</code>.
      </Callout>

      <h2 id="model">The mental model</h2>
      <p>Three resources, in order. Each builds on the one before it:</p>
      <div className="chips">
        <span className="chip"><b>1.</b> Connections — your provider keys</span>
        <span className="chip">→</span>
        <span className="chip"><b>2.</b> Agents — persona + which connections to use</span>
        <span className="chip">→</span>
        <span className="chip"><b>3.</b> Calls — dial a number with an agent</span>
      </div>
      <ul>
        <li><Link to="/connections">Connections</Link> store your encrypted provider credentials (Deepgram, Cartesia, Groq, Plivo, …).</li>
        <li><Link to="/agents">Agents</Link> bundle instructions, a voice, and the connections to run on.</li>
        <li><Link to="/calls">Calls</Link> place an outbound call (or receive an inbound one) using an agent.</li>
      </ul>

      <h2 id="auth">Authentication</h2>
      <p>
        Every request is authenticated with a tenant API key, sent as a bearer
        token. See <Link to="/authentication">Authentication</Link>.
      </p>
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl https://<your-offhook-host>/v1/calls \\\n  -H "Authorization: Bearer vk_live_…"` }]} />

      <h2 id="next">Next steps</h2>
      <ul>
        <li><Link to="/quickstart">Quickstart</Link> — make your first call end-to-end in five steps.</li>
        <li><Link to="/webhooks">Webhooks</Link> — receive call events as they happen.</li>
        <li><Link to="/errors">Errors &amp; limits</Link> — status codes, error codes, rate limits.</li>
      </ul>
    </>
  );
}
