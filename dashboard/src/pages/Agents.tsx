import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type Agent, api, type Connection, type Tool } from "../api";
import { Page, useAsync } from "../hooks";
import { BLANK, TEMPLATES, type AgentTemplate } from "../templates";
import { Spinner, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";
import TalkModal from "./TalkModal";

type Managed = { stt: string | null; tts: string | null; llm: string | null } | undefined;

export default function Agents() {
  const agents = useAsync(() => api.agents(), []);
  const conns = useAsync(() => api.connections(), []);
  const tools = useAsync(() => api.tools(), []);
  const providers = useAsync(() => api.providers(), []);
  // Links from the Overview checklist: ?new=1 opens the form, ?talk=<id> opens a test call.
  const [params, setParams] = useSearchParams();
  // false: closed; "pick": choose a template first; a template: start from it.
  const [open, setOpen] = useState<false | "pick" | AgentTemplate>(() => (params.get("new") ? "pick" : false));
  const [talking, setTalking] = useState<{ agent: Agent; context?: Record<string, unknown> } | null>(null);
  const linked = agents.data?.find((a) => a.id === params.get("talk"));
  const talk = talking ?? (linked ? { agent: linked } : null);
  const closeTalk = () => { setTalking(null); if (params.has("talk")) setParams({}, { replace: true }); };
  const toast = useToast();

  async function del(id: string) {
    if (!confirm("Delete this agent?")) return;
    try { await api.deleteAgent(id); agents.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  const ready = !providers.loading && !conns.loading;

  return (
    <Page title="Agents" sub="Who calls, what they say, and what they write down. Talk to one in your browser before it calls anyone."
      actions={<button className="btn btn-primary" onClick={() => setOpen("pick")}><Icon name="plus" size={15} /> New agent</button>}>
      <div className="card">
        {agents.loading ? <Spinner /> : !agents.data?.length ? (
          <div className="first-agent">
            <h2 className="first-agent-title">Create your first agent</h2>
            <p className="muted">Start from a template. No keys needed: it runs on Offhook's providers until you add your own.</p>
            <div className="template-grid">
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" className="template-card" onClick={() => setOpen(t)}>
                  <strong>{t.title}</strong><span>{t.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Company</th><th>Instructions</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {agents.data.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.name}</td>
                  <td className="muted">{a.company || "—"}</td>
                  <td className="muted" style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.instructions}</td>
                  <td className="muted">{fmtDate(a.created_at)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setTalking({ agent: a })} title="Talk to this agent in your browser">
                        <Icon name="calls" size={13} /> Talk
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => del(a.id)} aria-label={`Delete ${a.name}`}><Icon name="trash" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {talk && <TalkModal agent={talk.agent} initialContext={talk.context} onClose={closeTalk} />}
      {open && ready && (
        <CreateModal conns={conns.data || []} tools={tools.data || []} managed={providers.data?.managed}
          initialTemplate={open === "pick" ? null : open}
          onClose={() => { setOpen(false); if (params.has("new")) setParams({}, { replace: true }); }}
          onDone={(agent, context) => { setOpen(false); agents.reload(); setTalking({ agent, context }); }} />
      )}
    </Page>
  );
}

const MODEL_DEFAULTS: Record<string, string> = {
  groq: "openai/gpt-oss-20b", gemini: "gemini-2.5-flash",
  openrouter: "google/gemini-2.5-flash", openai: "gpt-4o-mini",
};
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  groq: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  openrouter: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

/** The value a picker uses for "Offhook's own provider" (sent to the API as no connection). */
const OFFHOOK = "offhook";

const LEG_LABEL: Record<string, string> = {
  stt: "Speech to text",
  tts: "Voice",
  llm: "Language model",
  telephony: "Phone line (for phone calls)",
};
const PROVIDER_NAME: Record<string, string> = { deepgram: "Deepgram", cartesia: "Cartesia", groq: "Groq" };

/**
 * New agent: pick a template, edit the essentials, save, and go straight to
 * talking to it. Providers, model and tools are folded away with sensible defaults.
 */
function CreateModal({ conns, tools, managed, initialTemplate, onClose, onDone }: {
  conns: Connection[]; tools: Tool[]; managed: Managed; initialTemplate: AgentTemplate | null;
  onClose: () => void; onDone: (agent: Agent, context: Record<string, unknown>) => void;
}) {
  const [template, setTemplate] = useState<AgentTemplate | null>(initialTemplate);
  const [f, setF] = useState(() => ({
    name: initialTemplate?.name ?? "", company: initialTemplate?.company ?? "",
    instructions: initialTemplate?.instructions ?? "", first_message: initialTemplate?.first_message ?? "",
    voice_id: "", llm_model: "",
  }));
  // Offhook's providers are picked by default for any leg the workspace has no keys for;
  // otherwise the workspace's first connection of that kind.
  const [sel, setSel] = useState<Record<string, string>>(() => {
    const start: Record<string, string> = {};
    for (const leg of ["stt", "tts", "llm"] as const) {
      const own = conns.find((c) => c.provider_kind === leg);
      if (own) start[leg] = own.id;
      else if (managed?.[leg]) start[leg] = OFFHOOK;
    }
    const line = conns.find((c) => c.provider_kind === "telephony");
    if (line) start.telephony = line.id;
    return start;
  });
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const byKind = (k: string) => conns.filter((c) => c.provider_kind === k);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const llmProvider = sel.llm === OFFHOOK ? managed?.llm ?? undefined : conns.find((c) => c.id === sel.llm)?.provider_name;
  const connId = (leg: string) => (sel[leg] === OFFHOOK ? null : sel[leg]);
  const toggleTool = (id: string) =>
    setToolIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  function pick(t: AgentTemplate) {
    setTemplate(t);
    setF((s) => ({ ...s, name: t.name, company: t.company, instructions: t.instructions, first_message: t.first_message }));
  }

  async function save() {
    setBusy(true);
    try {
      const agent = await api.createAgent({
        name: f.name, company: f.company || null, instructions: f.instructions,
        first_message: f.first_message || null, voice_id: f.voice_id || null,
        llm_model: f.llm_model.trim() || null,
        stt_connection_id: connId("stt"), tts_connection_id: connId("tts"), llm_connection_id: connId("llm"),
        telephony_connection_id: sel.telephony || null,
        tool_ids: toolIds,
      });
      toast(`${agent.name} is ready. Say hello.`);
      onDone(agent, template?.context ?? {});
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  const ready = f.name && f.instructions && sel.stt && sel.tts && sel.llm;
  const summary = (["stt", "tts", "llm"] as const).map((leg) =>
    sel[leg] === OFFHOOK ? `Offhook's ${PROVIDER_NAME[managed?.[leg] ?? ""] ?? managed?.[leg]}`
      : conns.find((c) => c.id === sel[leg])?.name ?? "not set").join(", ");

  if (!template) {
    return (
      <Modal title="New agent" onClose={onClose}
        footer={<button className="btn btn-ghost" onClick={onClose}>Cancel</button>}>
        <p className="muted" style={{ marginTop: 0 }}>Start from a template and change anything, or start from scratch.</p>
        <div className="template-list">
          {[...TEMPLATES, BLANK].map((t) => (
            <button key={t.id} type="button" className="template-card" onClick={() => pick(t)}>
              <strong>{t.title}</strong><span>{t.blurb}</span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={template.id === "blank" ? "New agent" : template.title} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={() => setTemplate(null)}>Back</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Create and talk to it"}</button>
      </>}>
      <div className="cols-2 grid" style={{ gap: 12 }}>
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Alex" /></Field>
        <Field label="Company"><input className="input" value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Acme Clinic" /></Field>
      </div>
      <Field label="Instructions" hint="What the agent is for: what to ask, in what order, and what to write down.">
        <textarea className="input" rows={6} value={f.instructions} onChange={(e) => set("instructions", e.target.value)}
          placeholder="You are calling to confirm a dental appointment…" />
      </Field>
      <Field label="Opening line" hint="The first thing the agent says when the call connects.">
        <input className="input" value={f.first_message} onChange={(e) => set("first_message", e.target.value)} placeholder="Hi, this is Alex from Acme…" />
      </Field>

      <div className="advanced">
        <button type="button" className="advanced-toggle" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          <span>
            <strong>Providers, phone line and tools</strong>
            <span className="dim">{summary}{sel.telephony ? ", with a phone line" : ""}</span>
          </span>
          <span className={`advanced-chev${advanced ? " open" : ""}`}><Icon name="chev" size={16} /></span>
        </button>
        {advanced && (
          <div className="advanced-body">
            {(["stt", "tts", "llm", "telephony"] as const).map((k) => (
              <div key={k}>
                <Field label={LEG_LABEL[k]}
                  hint={k === "telephony" ? "Only needed for real phone calls. Talking in the browser works without it."
                    : sel[k] === OFFHOOK ? "Offhook's account, free for now. Or pick your own connection." : undefined}>
                  <Select value={sel[k] || ""} onChange={(v) => setSel((s) => ({ ...s, [k]: v }))}
                    placeholder={k === "telephony" ? "None" : "Choose…"}
                    emptyText={`No ${k === "telephony" ? "phone line" : LEG_LABEL[k].toLowerCase()} connections yet. Add one on Connections.`}
                    options={[
                      ...(k !== "telephony" && managed?.[k]
                        ? [{ value: OFFHOOK, label: `Offhook's ${PROVIDER_NAME[managed[k]!] ?? managed[k]} (free)` }]
                        : []),
                      ...byKind(k).map((c) => ({ value: c.id, label: `${c.name} (${c.provider_name})` })),
                    ]} />
                </Field>
                {k === "llm" && (
                  <Field label="Model"
                    hint={llmProvider ? `Leave blank for the default: ${MODEL_DEFAULTS[llmProvider] || "the provider's"}` : "Optional."}>
                    <input className="input mono" value={f.llm_model} onChange={(e) => set("llm_model", e.target.value)}
                      placeholder={llmProvider ? MODEL_DEFAULTS[llmProvider] || "model name" : "model name"} />
                    {llmProvider && MODEL_SUGGESTIONS[llmProvider] && (
                      <div className="wrap" style={{ marginTop: 8 }}>
                        {MODEL_SUGGESTIONS[llmProvider].map((m) => (
                          <button type="button" key={m} className="btn btn-ghost btn-sm" style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                            onClick={() => set("llm_model", m)}>{m}</button>
                        ))}
                      </div>
                    )}
                  </Field>
                )}
              </div>
            ))}
            <Field label="Tools" hint="Functions the agent can call during a call to look things up.">
              {!tools.length ? (
                <div className="dim" style={{ fontSize: 13 }}>No tools yet. Create one on the Tools page.</div>
              ) : (
                <div style={{ display: "grid", gap: 6 }}>
                  {tools.map((t) => (
                    <label key={t.id} className="row" style={{ gap: 8, cursor: "pointer", fontSize: 14 }}>
                      <input type="checkbox" checked={toolIds.includes(t.id)} onChange={() => toggleTool(t.id)} />
                      <span className="mono" style={{ fontWeight: 600 }}>{t.name}</span>
                      <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
