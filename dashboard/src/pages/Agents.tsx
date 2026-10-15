import { useState } from "react";
import { api, type Connection, type Tool } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Empty, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

export default function Agents() {
  const agents = useAsync(() => api.agents(), []);
  const conns = useAsync(() => api.connections(), []);
  const tools = useAsync(() => api.tools(), []);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  async function del(id: string) {
    if (!confirm("Delete this agent?")) return;
    try { await api.deleteAgent(id); agents.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Agents" sub="Reusable personas — instructions, voice, and the connections they run on."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> New agent</button>}>
      <div className="card">
        {agents.loading ? <Spinner /> : !agents.data?.length ? (
          <Empty title="No agents" hint="Create an agent to place calls with." icon="agents" />
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
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(a.id)}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <CreateModal conns={conns.data || []} tools={tools.data || []} onClose={() => setOpen(false)} onDone={() => { setOpen(false); agents.reload(); }} />}
    </Page>
  );
}

const MODEL_DEFAULTS: Record<string, string> = {
  groq: "llama-3.1-8b-instant", gemini: "gemini-2.5-flash",
  openrouter: "google/gemini-2.5-flash", openai: "gpt-4o-mini",
};
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  groq: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
  openrouter: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
  openai: ["gpt-4o-mini", "gpt-4o"],
};

function CreateModal({ conns, tools, onClose, onDone }: { conns: Connection[]; tools: Tool[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", company: "", instructions: "", first_message: "", voice_id: "", llm_model: "" });
  const [sel, setSel] = useState<Record<string, string>>({});
  const [toolIds, setToolIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const byKind = (k: string) => conns.filter((c) => c.provider_kind === k);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const llmProvider = conns.find((c) => c.id === sel.llm)?.provider_name;
  const toggleTool = (id: string) =>
    setToolIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  async function save() {
    setBusy(true);
    try {
      await api.createAgent({
        name: f.name, company: f.company || null, instructions: f.instructions,
        first_message: f.first_message || null, voice_id: f.voice_id || null,
        llm_model: f.llm_model.trim() || null,
        stt_connection_id: sel.stt, tts_connection_id: sel.tts, llm_connection_id: sel.llm,
        telephony_connection_id: sel.telephony || null,
        tool_ids: toolIds,
      });
      toast("Agent created"); onDone();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  const ready = f.name && f.instructions && sel.stt && sel.tts && sel.llm;

  return (
    <Modal title="New agent" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Create agent"}</button>
      </>}>
      <Field label="Name"><input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Alex" /></Field>
      <Field label="Company"><input className="input" value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Acme Clinic" /></Field>
      <Field label="Instructions" hint="The agent's behaviour and goal.">
        <textarea className="input" value={f.instructions} onChange={(e) => set("instructions", e.target.value)}
          placeholder="You are calling to confirm a dental appointment…" />
      </Field>
      <Field label="First message"><input className="input" value={f.first_message} onChange={(e) => set("first_message", e.target.value)} placeholder="Hi, this is Alex from Acme…" /></Field>
      {(["stt", "tts", "llm", "telephony"] as const).map((k) => (
        <div key={k}>
          <Field label={`${k.toUpperCase()} connection${k === "telephony" ? " (for phone calls)" : ""}`}>
            <Select value={sel[k] || ""} onChange={(v) => setSel((s) => ({ ...s, [k]: v }))}
              placeholder="— select —"
              emptyText={`No ${k} connections — add one first`}
              options={byKind(k).map((c) => ({ value: c.id, label: `${c.name} (${c.provider_name})` }))} />
          </Field>
          {k === "llm" && (
            <Field label="LLM model"
              hint={llmProvider ? `Leave blank to use the default: ${MODEL_DEFAULTS[llmProvider] || "provider default"}` : "Optional — defaults to the provider's model."}>
              <input className="input mono" value={f.llm_model} onChange={(e) => set("llm_model", e.target.value)}
                placeholder={llmProvider ? MODEL_DEFAULTS[llmProvider] || "model name" : "select an LLM connection first"} />
              {llmProvider && MODEL_SUGGESTIONS[llmProvider] && (
                <div className="wrap" style={{ marginTop: 8 }}>
                  {MODEL_SUGGESTIONS[llmProvider].map((m) => (
                    <button type="button" key={m} className="btn btn-ghost btn-sm"
                      style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}
                      onClick={() => set("llm_model", m)}>{m}</button>
                  ))}
                </div>
              )}
            </Field>
          )}
        </div>
      ))}
      <Field label="Tools" hint="Functions the agent can call mid-call to fetch live data.">
        {!tools.length ? (
          <div className="dim" style={{ fontSize: 12.5 }}>No tools yet — create one on the Tools page.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {tools.map((t) => (
              <label key={t.id} className="row" style={{ gap: 8, cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={toolIds.includes(t.id)} onChange={() => toggleTool(t.id)} />
                <span className="mono" style={{ fontWeight: 600 }}>{t.name}</span>
                <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.description}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
    </Modal>
  );
}
