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
              <span className="dim mono" style={{ fontSize: 11 }}>{call.data.direction}</span>
            </div>
            <dl className="kv">
              <dt>call id</dt><dd className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{call.data.id}</dd>
              {call.data.to_number && (<><dt>to</dt><dd className="mono">{call.data.to_number}</dd></>)}
              {call.data.from_number && (<><dt>from</dt><dd className="mono">{call.data.from_number}</dd></>)}
              {call.data.provider_call_id && (<><dt>carrier id</dt><dd className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>{call.data.provider_call_id}</dd></>)}
              {call.data.error_code && (<><dt>error</dt><dd><span className="badge failed">{call.data.error_code}</span></dd></>)}
              {call.data.tags && Object.keys(call.data.tags).length > 0 && (
                <><dt>tags</dt><dd>
                  <span className="wrap" style={{ gap: 4 }}>
                    {Object.entries(call.data.tags).map(([k, v]) => (
                      <span key={k} className="badge neutral mono" style={{ fontSize: 11 }}>{k}:{v}</span>
                    ))}
                  </span>
                </dd></>
              )}
              <dt>duration</dt><dd className="num">{fmtDur(call.data.duration_seconds)}</dd>
              <dt>created</dt><dd>{fmtDate(call.data.created_at)}</dd>
              <dt>started</dt><dd>{fmtDate(call.data.started_at)}</dd>
              <dt>ended</dt><dd>{fmtDate(call.data.ended_at)}</dd>
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
              <span className="dim mono" style={{ fontSize: 11 }}>
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
                      <div style={{ background: "var(--clay-soft)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
                        <span className="mono dim" style={{ fontSize: 10.5 }}>SUMMARY · </span>{transcript.data.summary}
                      </div>
                    )}
                    {transcript.data.transcript.map((t, i) => (
                      <div className="turn" key={i}>
                        <div className={`turn-role ${t.role}`}>{t.role === "assistant" ? "Agent" : "Caller"}</div>
                        <div className="turn-text">{t.text}</div>
                      </div>
                    ))}
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
      <div className="mono dim" style={{ fontSize: 10.5, marginBottom: 7, textTransform: "uppercase", letterSpacing: ".08em" }}>Recording</div>
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
