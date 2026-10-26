// The Overview's "Get started" checklist for a new workspace. Every step is
// worked out from the workspace's data (agents, connections, calls, keys), except
// "talked to it", which TalkModal records in localStorage (test calls aren't stored).
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../hooks";
import { Icon } from "../ui";

const HIDE_KEY = "oh-setup-hidden";

function stored(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

interface Step {
  title: string;
  hint: string;
  done: boolean;
  action?: { label: string; to: string };
  waiting?: string;
  optional?: boolean;
}

/**
 * Get started: create an agent, talk to it, connect a phone line, place a call,
 * and (for developers) create an API key.
 * Args: totalCalls — calls this workspace has made (from the stats).
 */
export default function GetStarted({ totalCalls }: { totalCalls: number }) {
  const agents = useAsync(() => api.agents(), []);
  const conns = useAsync(() => api.connections(), []);
  const keys = useAsync(() => api.apiKeys(), []);
  const [hidden, setHidden] = useState(() => stored(HIDE_KEY));
  if (agents.loading || conns.loading || keys.loading) return null;

  const first = agents.data?.[0];
  const hasAgent = Boolean(first);
  const hasLine = Boolean(conns.data?.some((c) => c.provider_kind === "telephony"));
  const steps: Step[] = [
    {
      title: "Create your first agent",
      hint: "Start from a template. No keys needed: it runs on Offhook's providers until you add your own.",
      done: hasAgent,
      action: { label: "Create an agent", to: "/agents?new=1" },
    },
    {
      title: first ? `Talk to ${first.name}` : "Talk to it in your browser",
      hint: "Hear how it sounds and what it writes down. Nothing is dialled.",
      done: stored("oh-talked"),
      action: first ? { label: "Start talking", to: `/agents?talk=${first.id}` } : undefined,
      waiting: "Create an agent first.",
    },
    {
      title: "Connect a phone line",
      hint: "Add your Twilio or Plivo account and number, then attach it to an agent.",
      done: hasLine,
      action: { label: "Add a phone line", to: "/connections?new=telephony" },
    },
    {
      title: "Make a phone call",
      hint: "Call your own phone first. The transcript and results land in Calls.",
      done: totalCalls > 0,
      action: hasAgent && hasLine ? { label: "Place a call", to: "/calls?new=1" } : undefined,
      waiting: "Needs an agent with a phone line.",
    },
    {
      title: "Call from your code",
      hint: "Create an API key and place calls with POST /v1/calls.",
      done: Boolean(keys.data?.length),
      action: { label: "Create an API key", to: "/keys" },
      optional: true,
    },
  ];
  const core = steps.filter((s) => !s.optional);
  const doneCount = core.filter((s) => s.done).length;
  const allDone = doneCount === core.length;
  if (hidden && allDone) return null;
  const next = steps.find((s) => !s.done && s.action);

  return (
    <section className="card setup" aria-labelledby="setup-title">
      <div className="setup-head">
        <div>
          <h2 id="setup-title" className="setup-title">{allDone ? "You're set up" : "Get started"}</h2>
          <p className="muted">{allDone ? "Everything's connected. Hide this when you like." : `${doneCount} of ${core.length} done`}</p>
        </div>
        {allDone && (
          <button className="btn btn-ghost btn-sm" onClick={() => { try { localStorage.setItem(HIDE_KEY, "1"); } catch { /* */ } setHidden(true); }}>Hide</button>
        )}
      </div>
      <div className="setup-bar" aria-hidden="true"><span style={{ width: `${(doneCount / core.length) * 100}%` }} /></div>
      <ol className="setup-steps">
        {steps.map((s, i) => (
          <li key={i} className={`setup-step${s.done ? " done" : ""}${s === next ? " next" : ""}`}>
            <span className="setup-mark" aria-hidden="true">{s.done ? <Icon name="check" size={14} /> : i + 1}</span>
            <div className="setup-body">
              <strong>{s.title}{s.optional && <span className="dim" style={{ fontWeight: 500 }}> · optional</span>}</strong>
              <span className="muted">{s.hint}</span>
            </div>
            <div className="setup-action">
              {s.done ? <span className="badge completed">Done</span>
                : s.action ? <Link className={`btn btn-sm ${s === next ? "btn-primary" : "btn-ghost"}`} to={s.action.to}>{s.action.label}</Link>
                : <span className="dim" style={{ fontSize: 13 }}>{s.waiting}</span>}
            </div>
            <span className="sr-only">{s.done ? "Done." : "Not done yet."}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
