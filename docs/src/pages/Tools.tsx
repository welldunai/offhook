import { Link } from "react-router-dom";
import { Code, Callout, Endpoint, Params } from "../components";

export default function Tools() {
  return (
    <>
      <div className="eyebrow">Core resources</div>
      <h1>Tools</h1>
      <p className="lead">
        Give your agent functions it can call <em>during</em> a call to fetch
        live data from your own APIs — check an order, look up stock, read a
        booking. You declare the function; we call your endpoint with the model's
        arguments and feed the result back into the conversation.
      </p>

      <h2 id="how">How it works</h2>
      <ol>
        <li>You define a tool: a <code>name</code>, a <code>description</code> (this is what tells the model <em>when</em> to use it), an argument schema, and an HTTP endpoint.</li>
        <li>You attach the tool to an <Link to="/agents">agent</Link> via <code>tool_ids</code>.</li>
        <li>Mid-call, when the agent decides it needs that data, it calls the function. We issue the HTTP request to your endpoint with the model-supplied arguments and return the JSON response to the model, which keeps talking.</li>
      </ol>
      <Callout kind="note">
        Because the model waits for your endpoint, keep it fast. Requests are
        bounded by the tool's <code>timeout_seconds</code> (max 20), and a good
        agent will say "one moment, let me pull that up" before calling a tool.
      </Callout>

      <h2 id="own-code">Running your own code as a tool</h2>
      <p>
        A tool <em>is</em> your code — Offhook doesn't host or execute it, it
        calls it. To run arbitrary logic (a database lookup, a calculation, a
        call to another API), wrap that logic in a small HTTP endpoint on your
        side and point a tool at it. Your code runs in your environment, with
        your dependencies and your secrets; we only send the model's arguments
        and read back the result. This is the same model Twilio, Retell, and
        Vapi use — and it keeps the security boundary clean: your code, your
        blast radius.
      </p>
      <Code tabs={[{ label: "Your endpoint (Python)", lang: "text", code: `# Your own server — FastAPI, Flask, a Lambda, a Cloud Function, anything.
from fastapi import FastAPI

app = FastAPI()

@app.get("/tools/orders/{order_id}")
def check_order_status(order_id: str):
    order = db.query(Order).get(order_id)   # your code, your DB, your deps
    if order is None:
        return {"found": False}
    return {
        "found": True,
        "status": order.status,
        "items": order.item_count,
        "delivery_date": str(order.delivery_date),
    }` }, { label: "Register it", lang: "bash", code: `curl -X POST http://localhost:8000/v1/tools \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "check_order_status",
    "description": "Look up an order by ID; returns status, items, and delivery date.",
    "method": "GET",
    "url": "https://api.yourapp.com/tools/orders/{order_id}",
    "parameters": {
      "properties": { "order_id": { "type": "string" } },
      "required": ["order_id"]
    },
    "headers": { "Authorization": "Bearer your-internal-key" }
  }'` }]} />
      <p>Two things to get right when pointing a tool at your own code:</p>
      <ul>
        <li><b>Public HTTPS only.</b> Requests to private, loopback, or cloud-metadata addresses are blocked. For local development, expose your endpoint through a tunnel (e.g. ngrok) and use that URL — the same way you tunnel for telephony webhooks.</li>
        <li><b>Return fast.</b> The agent is waiting mid-conversation, so the endpoint must answer within <code>timeout_seconds</code> (max 20). For slow work, kick it off in the background and return immediately — then surface the result on a later turn or via a <Link to="/webhooks">webhook</Link>.</li>
      </ul>

      <h2 id="create">Create a tool</h2>
      <Endpoint method="POST" path="/v1/tools" />
      <Params rows={[
        { name: "name", type: "string", required: true, desc: "The function name the model calls. A valid identifier, e.g. check_order_status. Unique per workspace." },
        { name: "description", type: "string", required: true, desc: "What the tool does and when to use it. Drives whether the model calls it." },
        { name: "parameters", type: "object", desc: "The arguments, JSON-Schema style: { properties: { ... }, required: [ ... ] }." },
        { name: "method", type: "string", desc: "GET (default) or POST." },
        { name: "url", type: "string", required: true, desc: "Your HTTPS endpoint. Use {param} to drop an argument into the path." },
        { name: "headers", type: "object", desc: "Static auth headers (e.g. Authorization). Encrypted at rest and never returned." },
        { name: "timeout_seconds", type: "int", desc: "1–20, default 10." },
      ]} />
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/tools \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "check_order_status",
    "description": "Look up an order by its ID and return its status, items, and delivery date.",
    "method": "GET",
    "url": "https://api.yourapp.com/orders/{order_id}",
    "parameters": {
      "properties": {
        "order_id": { "type": "string", "description": "The order ID, e.g. ORD-1042" }
      },
      "required": ["order_id"]
    },
    "headers": { "Authorization": "Bearer sk_live_…" },
    "timeout_seconds": 8
  }'` }, { label: "Response", lang: "json", code: `{
  "id": "tool_3f9a…",
  "name": "check_order_status",
  "description": "Look up an order by its ID…",
  "method": "GET",
  "url": "https://api.yourapp.com/orders/{order_id}",
  "parameters": { "properties": { "order_id": { "type": "string" } }, "required": ["order_id"] },
  "has_auth": true,
  "timeout_seconds": 8,
  "created_at": "2026-06-21T10:00:00Z"
}` }]} />

      <h2 id="mapping">How arguments map to the request</h2>
      <p>The model's arguments are placed into the request in a fixed, predictable way — they can never change the host, scheme, method, or headers:</p>
      <ul>
        <li><b>Path placeholders.</b> Any <code>{'{name}'}</code> in the URL is replaced with that argument, URL-encoded.</li>
        <li><b>GET.</b> Remaining arguments become the query string.</li>
        <li><b>POST.</b> Remaining arguments become the JSON request body.</li>
      </ul>
      <p>So <code>check_order_status(order_id="ORD-1042")</code> above issues <code>GET https://api.yourapp.com/orders/ORD-1042</code> with your auth header.</p>

      <h2 id="attach">Attach a tool to an agent</h2>
      <p>Pass <code>tool_ids</code> when creating the agent. The agent can then call any of its tools during a call.</p>
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl -X POST http://localhost:8000/v1/agents \\
  -H "Authorization: Bearer $OFFHOOK_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Order support",
    "instructions": "Help the caller with questions about their order. Use check_order_status to look up specifics.",
    "stt_connection_id": "conn_…",
    "tts_connection_id": "conn_…",
    "llm_connection_id": "conn_…",
    "tool_ids": ["tool_3f9a…"]
  }'` }]} />

      <h2 id="list">List, fetch & delete</h2>
      <Endpoint method="GET" path="/v1/tools" />
      <Endpoint method="GET" path="/v1/tools/{id}" />
      <Endpoint method="PATCH" path="/v1/tools/{id}" />
      <Endpoint method="DELETE" path="/v1/tools/{id}" />
      <p>Header values are write-only — they are never returned. The response only tells you whether auth headers are set (<code>has_auth</code>).</p>

      <h2 id="result">What the model receives</h2>
      <p>A 2xx response is handed back as <code>{'{ "ok": true, "result": <your JSON> }'}</code> (truncated if very large). Any error (non-2xx, timeout, blocked URL) comes back as <code>{'{ "error": "…" }'}</code> so the agent can apologize and continue rather than the call failing.</p>

      <Callout kind="warn">
        Tool endpoints must be public HTTPS URLs. Requests to private,
        loopback, or cloud-metadata addresses are blocked. Treat the data your
        endpoint returns as untrusted input to the model — don't return secrets
        you wouldn't want spoken aloud.
      </Callout>
    </>
  );
}
