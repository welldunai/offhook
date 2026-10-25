// Talk to an agent in the browser: a test call, not a phone call. It uses the
// workspace's own connections (STT, LLM, TTS) and tools, like a real call.
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Agent } from "../api";
import { LiveCall, prepareAudio } from "../talk/call";
import { Icon, Modal } from "../ui";

type Stage = "brief" | "connecting" | "live" | "ended";
interface Turn { who: "agent" | "person"; text: string }

const ENDED: Record<string, string> = {
  agent_ended: "The agent wrapped up the call.",
  hung_up: "You hung up.",
  time_limit: "The call reached its time limit.",
  silence: "The call ended after a long silence.",
  disconnected: "The call was disconnected.",
  error: "The call ended because of a problem.",
};

const WAVE = [8, 14, 20, 12, 24, 16, 10, 22, 18, 12, 26, 14, 9, 20, 16, 24, 11, 18];

/**
 * The test-call dialog for one agent.
 * Args: agent — the agent to talk to; onClose — closes the dialog (hangs up first).
 */
export default function TalkModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>("brief");
  const [context, setContext] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [left, setLeft] = useState(0);
  const [wrapping, setWrapping] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [ending, setEnding] = useState<{ reason: string | null; summary: string | null } | null>(null);
  const call = useRef<LiveCall | null>(null);
  const timers = useRef<number[]>([]);
  const bottom = useRef<HTMLDivElement | null>(null);

  // Closing the dialog always ends a call in progress.
  useEffect(() => () => {
    call.current?.hangUp();
    timers.current.forEach(clearInterval);
  }, []);
  useEffect(() => bottom.current?.scrollIntoView({ block: "nearest" }), [turns]);

  async function start() {
    setProblem(null);
    let ctx: Record<string, unknown> = {};
    if (context.trim()) {
      try {
        ctx = JSON.parse(context);
        if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) throw new Error();
      } catch {
        return setProblem('Call context must be a JSON object, like { "name": "Priya" }.');
      }
    }
    setStage("connecting");
    let prepared: Awaited<ReturnType<typeof prepareAudio>>;
    try {
      prepared = await prepareAudio();
    } catch (e) {
      setStage("brief");
      return setProblem((e as Error).message);
    }
    try {
      const t = await api.testCall(agent.id, ctx);
      setTurns([]);
      setResults({});
      call.current = new LiveCall(t.ws_url, t.ticket, prepared, {
        onLive: () => {
          setStage("live");
          const end = Date.now() + t.max_seconds * 1000;
          const tick = () => setLeft(Math.max(0, Math.round((end - Date.now()) / 1000)));
          tick();
          timers.current.push(window.setInterval(tick, 1000));
          timers.current.push(window.setInterval(() => setSpeaking(Boolean(call.current?.agentSpeaking)), 150));
        },
        onTranscript: (who, text) =>
          setTurns((ts) => {
            const last = ts[ts.length - 1];
            // Speech-to-text splits long turns; keep one bubble per turn.
            return last?.who === who ? [...ts.slice(0, -1), { who, text: `${last.text} ${text}` }] : [...ts, { who, text }];
          }),
        onResult: (key, value) => setResults((r) => ({ ...r, [key]: value })),
        onWrapUp: () => setWrapping(true),
        onEnded: (reason, summary, message) => {
          timers.current.forEach(clearInterval);
          timers.current = [];
          setSpeaking(false);
          setEnding({ reason, summary });
          if (message) setProblem(message);
          setStage("ended");
          call.current = null;
        },
      });
      call.current.connect();
    } catch (e) {
      prepared.audio.stop();
      setStage("brief");
      setProblem(
        e instanceof ApiError && e.status === 409 ? `${agent.name} can't take a test call yet: ${e.message}.`
        : e instanceof ApiError ? e.message : "Couldn't start the test call. Try again in a moment.",
      );
    }
  }

  const status =
    stage === "connecting" ? { cls: "dialing", text: "Connecting" } :
    stage === "live" ? { cls: "in_progress", text: "On the call" } :
    { cls: problem ? "failed" : "completed", text: "Call ended" };
  const meta = stage === "live" ? (wrapping ? "Wrapping up" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`)
    : stage === "ended" ? (ENDED[ending?.reason ?? ""] ?? "The call has ended.") : "Up to 5 minutes";

  const footer = stage === "brief" ? (
    <>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={start}><Icon name="calls" size={14} /> Start talking</button>
    </>
  ) : stage === "ended" ? (
    <>
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
      <button className="btn btn-primary" onClick={() => { setStage("brief"); setEnding(null); setProblem(null); setWrapping(false); }}>Talk again</button>
    </>
  ) : (
    <button className="btn btn-danger" onClick={() => call.current?.hangUp()}>Hang up</button>
  );

  return (
    <Modal title={`Talk to ${agent.name}`} onClose={onClose} footer={footer}>
      {stage === "brief" ? (
        <div className="talk-brief">
          <p className="muted" style={{ margin: 0 }}>
            Talk to {agent.name} in your browser, the way someone on a call would. Nothing is dialled: it's a test, using
            this workspace's own speech, language model and voice providers and tools, billed to your keys.
          </p>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="talk-context">Call context <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <textarea id="talk-context" className="input mono" rows={3} value={context} onChange={(e) => setContext(e.target.value)}
              placeholder={'{ "name": "Priya", "appointment": "Tuesday 3 PM" }'} />
            <span className="hint">The facts a real call would pass in <code>context</code>.</span>
          </div>
          {problem && <p className="talk-problem" role="alert">{problem}</p>}
        </div>
      ) : (
        <div className="talk">
          <div className="talk-head">
            <span className="talk-avatar" aria-hidden="true">{agent.name[0]}</span>
            <div className="talk-who">
              <strong>{agent.name}{agent.company ? ` from ${agent.company}` : ""}</strong>
              <span className="dim">{meta}</span>
            </div>
            <span className={`badge ${status.cls}`}><span className="dot" />{status.text}</span>
          </div>
          <div className={`talk-wave${speaking ? " talk-wave--live" : ""}`} aria-hidden="true">
            {WAVE.map((h, i) => <i key={i} style={{ height: h }} />)}
          </div>
          <ul className="bubbles talk-bubbles" aria-label="Transcript" aria-live="polite">
            {turns.length === 0 && <li className="dim" style={{ fontSize: 14 }}>{stage === "connecting" ? "Connecting…" : `${agent.name} speaks first.`}</li>}
            {turns.map((t, i) => (
              <li key={i} className={`bubble${t.who === "agent" ? "" : " bubble--caller"}`}>{t.text}</li>
            ))}
            <div ref={bottom} />
          </ul>
          {Object.keys(results).length > 0 && (
            <div>
              <div className="talk-label">{stage === "ended" ? `What ${agent.name} wrote down` : "Written down so far"}</div>
              <div className="talk-results">
                {Object.entries(results).map(([k, v]) => (
                  <div className="talk-result" key={k}><span className="mono">{k}</span><strong>{shown(v)}</strong></div>
                ))}
              </div>
            </div>
          )}
          {stage === "ended" && ending?.summary && (
            <div className="call-summary" style={{ margin: 0 }}>
              <span className="call-summary-label">Summary</span>
              <p>{ending.summary}</p>
            </div>
          )}
          {problem && <p className="talk-problem" role="alert">{problem}</p>}
        </div>
      )}
    </Modal>
  );
}

/** Shows recorded values the way people say them. */
function shown(v: unknown): string {
  if (v === true || v === "true" || v === "yes") return "Yes";
  if (v === false || v === "false" || v === "no") return "No";
  return v === null || v === undefined || v === "" ? "—" : String(v);
}
