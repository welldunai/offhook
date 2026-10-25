import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Badge, Spinner, Empty, Icon, fmtDur, fmtDate, useToast } from "../ui";

const EVENT_COLOR: Record<string, string> = {
  "call.queued": "var(--slate)", "call.received": "var(--slate)",
  "call.dialing": "var(--amber)", "call.in_progress": "var(--amber)",
  "call.completed": "var(--pine)", "call.failed": "var(--rust)",
  "carrier.hangup": "var(--ink-3)",
};

export default function CallDetail() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<"events" | "transcript">("events");
  const call = useAsync(() => api.call(id), [id]);
  const events = useAsync(() => api.callEvents(id), [id]);
  const transcript = useAsync(() => api.callTranscript(id), [id]);
  const toast = useToast();

  return (
    <Page title="Call detail"
      sub={id}
      actions={<Link to="/calls" className="btn btn-ghost btn-sm"><Icon name="back" size={14} /> Back to calls</Link>}>
      {call.loading ? <Spinner /> : call.error ? (
        <div className="card card-pad" style={{ color: "var(--rust)" }}>{call.error}</div>
      ) : call.data && (
        <div className="grid" style={{ gridTemplateColumns: "320px 1fr", alignItems: "start" }}>
          {/* summary */}
          <div className="card card-pad">
            <div className="between" style={{ marginBottom: 16 }}>
              <Badge status={call.data.status} />
              <span className="dim" style={{ fontSize: 13 }}>{call.data.direction === "inbound" ? "Inbound" : "Outbound"}</span>
            </div>
            <dl className="kv">
              <dt>Call ID</dt><dd className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{call.data.id}</dd>
              {call.data.to_number && (<><dt>To</dt><dd className="mono">{call.data.to_number}</dd></>)}
              {call.data.from_number && (<><dt>From</dt><dd className="mono">{call.data.from_number}</dd></>)}
              {call.data.provider_call_id && (<><dt>Carrier ID</dt><dd className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{call.data.provider_call_id}</dd></>)}
              {call.data.error_code && (<><dt>Error</dt><dd><span className="badge failed">{call.data.error_code}</span></dd></>)}
              {call.data.tags && Object.keys(call.data.tags).length > 0 && (
                <><dt>Tags</dt><dd>
                  <span className="wrap" style={{ gap: 4 }}>
                    {Object.entries(call.data.tags).map(([k, v]) => (
                      <span key={k} className="badge neutral">{k}: {v}</span>
                    ))}
                  </span>
                </dd></>
              )}
              <dt>Duration</dt><dd className="num">{fmtDur(call.data.duration_seconds)}</dd>
              <dt>Created</dt><dd>{fmtDate(call.data.created_at)}</dd>
              <dt>Started</dt><dd>{fmtDate(call.data.started_at)}</dd>
              <dt>Ended</dt><dd>{fmtDate(call.data.ended_at)}</dd>
            </dl>
            {call.data.has_recording && <Recording id={id} />}
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 16, width: "100%", justifyContent: "center" }}
              onClick={() => { navigator.clipboard.writeText(call.data!.id); toast("Call ID copied"); }}>
              <Icon name="copy" size={13} /> Copy call ID
            </button>
          </div>

          {/* timeline + transcript */}
          <div className="card">
            <div className="card-head">
              <div className="pill-toggle">
                <button className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>Event log</button>
                <button className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}>Transcript</button>
              </div>
              <span className="dim" style={{ fontSize: 13 }}>
                {tab === "events" ? `${events.data?.length ?? 0} events` : `${transcript.data?.transcript.length ?? 0} turns`}
              </span>
            </div>
            <div className="card-pad">
              {tab === "events" ? (
                events.loading ? <Spinner /> : !events.data?.length ? <Empty title="No events yet" icon="doc" /> : (
                  <div className="timeline">
                    {events.data.map((e, i) => (
                      <div className="tl-item" key={i}>
                        <div className="tl-node" style={{ background: EVENT_COLOR[e.type] || "var(--ink-3)" }} />
                        <div className="tl-body">
                          <div>
                            <span className="tl-type" style={{ color: EVENT_COLOR[e.type] || "var(--ink)" }}>{e.type}</span>
                            <span className="tl-time">{fmtDate(e.ts)}</span>
                            {e.error_code && <span className="badge failed" style={{ marginLeft: 8, fontSize: 10 }}>{e.error_code}</span>}
                          </div>
                          {Object.keys(e.data || {}).length > 0 && (
                            <div className="tl-data">{renderData(e.data)}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                transcript.loading ? <Spinner /> : !transcript.data?.transcript.length ? (
                  <Empty title="No transcript" hint="Conversation content appears here once the call connects." icon="agents" />
                ) : (
                  <>
                    {transcript.data.summary && (
                      <div className="call-summary">
                        <span className="call-summary-label">Summary</span>
                        <p>{transcript.data.summary}</p>
                      </div>
                    )}
                    <ul className="bubbles" aria-label="Transcript">
                      {mergeTurns(transcript.data.transcript).map((t, i) => (
                        <li key={i} className={`bubble${t.role === "assistant" ? "" : " bubble--caller"}`}>
                          <span className="sr-only">{t.role === "assistant" ? "Agent: " : "Caller: "}</span>
                          {t.text}
                        </li>
                      ))}
                    </ul>
                  </>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

/**
 * Joins back-to-back lines from the same speaker: speech-to-text splits long
 * turns, which would otherwise show as a stack of fragments.
 * Args: turns — the transcript as stored.
 * Returns: one entry per spoken turn.
 */
function mergeTurns<T extends { role: string; text: string }>(turns: T[]): T[] {
  const out: T[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) out[out.length - 1] = { ...last, text: `${last.text} ${t.text}` };
    else out.push({ ...t });
  }
  return out;
}

function Recording({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let made = "";
    api.recordingUrl(id).then((u) => { made = u; setUrl(u); }).catch(() => setErr(true));
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return (
    <div style={{ marginTop: 16 }}>
      <div className="dim" style={{ fontSize: 13, fontWeight: 600, marginBottom: 7 }}>Recording</div>
      {err ? (
        <div className="muted" style={{ fontSize: 12.5 }}>Audio unavailable.</div>
      ) : url ? (
        <>
          <audio controls src={url} style={{ width: "100%", height: 38 }} />
          <a href={url} download={`call-${id}.wav`} className="btn btn-ghost btn-sm" style={{ marginTop: 8, width: "100%", justifyContent: "center" }}>
            <Icon name="doc" size={13} /> Download WAV
          </a>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>Loading audio…</div>
      )}
    </div>
  );
}

function renderData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .filter(([k, v]) => k !== "call_id" && v != null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("   ");
}
