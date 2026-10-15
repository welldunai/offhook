import { Link } from "react-router-dom";
import { Code, Endpoint } from "../components";

export default function Logs() {
  return (
    <>
      <div className="eyebrow">Events &amp; logs</div>
      <h1>Logs &amp; analytics</h1>
      <p className="lead">
        Every call leaves a complete, queryable trail: an event timeline, the
        transcript, aggregate stats, and metered usage.
      </p>

      <h2 id="timeline">Per-call audit log</h2>
      <p>
        The raw event timeline and transcript for a single call are documented
        under <Link to="/calls">Calls</Link>:
      </p>
      <Endpoint method="GET" path="/v1/calls/{id}/events" />
      <Endpoint method="GET" path="/v1/calls/{id}/transcript" />

      <h2 id="stats">Stats</h2>
      <Endpoint method="GET" path="/v1/stats" />
      <p>Aggregate metrics over a window (defaults to the current calendar month). Pass <code>since</code> / <code>until</code> (ISO-8601) to change the range.</p>
      <Code tabs={[{ label: "cURL", lang: "bash", code: `curl http://localhost:8000/v1/stats \\
  -H "Authorization: Bearer $OFFHOOK_KEY"` }, { label: "Response", lang: "json", code: `{
  "total_calls": 1284,
  "by_status": { "completed": 1180, "failed": 104 },
  "by_error_code": { "no_answer": 71, "busy": 22, "carrier_error": 11 },
  "failure_rate": 0.081,
  "total_seconds": 41230,
  "avg_seconds": 34.9
}` }]} />

      <h2 id="usage">Usage</h2>
      <Endpoint method="GET" path="/v1/usage" />
      <p>Billable seconds and call count for a window (defaults to the current month).</p>
      <Code tabs={[{ label: "Response", lang: "json", code: `{ "total_seconds": 41230, "call_count": 1180 }` }]} />

      <h2 id="dashboard">Or use the console</h2>
      <p>
        Everything here is also rendered in the <a href="http://localhost:5273">Offhook console</a> —
        an activity feed, per-call timelines and transcripts, and charts — with no
        code required.
      </p>
    </>
  );
}
