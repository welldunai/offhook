import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Connection } from "../api";
import { Page, useAsync } from "../hooks";
import { checkValues, guideFor } from "../providerGuide";
import { Spinner, Empty, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

const KINDS = ["telephony", "stt", "tts", "llm"];
const KIND_LABEL: Record<string, string> = { stt: "Speech to text", tts: "Voice", llm: "Language model", telephony: "Phone line" };

export default function Connections() {
  const conns = useAsync(() => api.connections(), []);
  const provs = useAsync(() => api.providers(), []);
  // ?new=<kind> (from the Overview checklist) opens the form on that kind.
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<false | string>(() => params.get("new") || false);
  const close = () => { setOpen(false); if (params.has("new")) setParams({}, { replace: true }); };
  const toast = useToast();

  const supported = (provs.data?.supported as Record<string, string[]>) || {};

  async function del(id: string) {
    if (!confirm("Delete this connection?")) return;
    try { await api.deleteConnection(id); conns.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Connections" sub="Your own provider keys, stored encrypted and never shown again. Optional for speech, voice and the language model: agents can use Offhook's instead. A phone line needs your own Twilio or Plivo."
      actions={<button className="btn btn-primary" onClick={() => setOpen("telephony")}><Icon name="plus" size={15} /> New connection</button>}>
      <div className="card">
        {conns.loading ? <Spinner /> : !conns.data?.length ? (
          <Empty title="No connections yet" hint="You don't need any to start: agents use Offhook's speech, voice and language model. Add a phone line (Twilio or Plivo) to make real calls, or your own keys to use your accounts." icon="connections" />
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Provider</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {conns.data.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td><span className="badge neutral">{KIND_LABEL[c.provider_kind] || c.provider_kind}</span></td>
                  <td className="mono">{c.provider_name}</td>
                  <td className="muted">{fmtDate(c.created_at)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(c.id)}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <CreateModal supported={supported} initialKind={typeof open === "string" && open in KIND_LABEL ? open : "telephony"} onClose={close} onDone={() => { close(); conns.reload(); }} />}
    </Page>
  );
}

const KIND_HELP: Record<string, string> = {
  telephony: "A Twilio or Plivo account and number, so agents can make and take real phone calls.",
  stt: "Your own speech-to-text account. Optional: agents use Offhook's otherwise.",
  tts: "Your own voice account. Optional: agents use Offhook's otherwise.",
  llm: "Your own language model account. Optional: agents use Offhook's otherwise.",
};

/**
 * Add a connection, with the provider's own steps: where each value is, a link to
 * its console, and format checks before saving. After a phone line, offers to
 * attach it to agents that don't have one.
 */
function CreateModal({ supported, initialKind, onClose, onDone }: { supported: Record<string, string[]>; initialKind: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState(initialKind);
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<Connection | null>(null);
  const toast = useToast();

  // Most common first: Twilio before Plivo, Groq first for language models.
  const ORDER = ["twilio", "plivo", "deepgram", "cartesia", "groq", "openai", "gemini", "openrouter"];
  const rank = (p: string) => (ORDER.indexOf(p) + 1 || 99);
  const options = [...(supported[kind] || [])].sort((a, b) => rank(a) - rank(b));
  const prov = provider || options[0] || "";
  const guide = guideFor(prov);

  async function save() {
    const issue = checkValues(prov, secrets);
    if (issue) return setProblem(issue);
    setProblem(null);
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, v.trim()]));
      const conn = await api.createConnection({ name: name.trim() || guide.name, provider_kind: kind, provider_name: prov, secrets: clean });
      if (kind === "telephony") setSaved(conn);
      else { toast("Connection added"); onDone(); }
    } catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  }

  if (saved) return <AttachLine line={saved} onClose={onDone} />;

  return (
    <Modal title={kind === "telephony" ? "Add a phone line" : "Add a connection"} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !prov}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <Field label="What it's for" hint={KIND_HELP[kind]}>
        <Select value={kind} onChange={(v) => { setKind(v); setProvider(""); setSecrets({}); setProblem(null); }}
          options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </Field>
      <Field label="Provider">
        <Select value={prov} onChange={(v) => { setProvider(v); setSecrets({}); setProblem(null); }}
          options={options.map((o) => ({ value: o, label: guideFor(o).name }))} placeholder="Choose…" />
      </Field>
      {prov && (
        <div className="guide">
          {guide.steps.length > 0 && (
            <ol className="guide-steps">{guide.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          )}
          {guide.console.url !== "#" && (
            <a className="guide-link" href={guide.console.url} target="_blank" rel="noreferrer">
              {guide.console.label} <Icon name="ext" size={13} />
            </a>
          )}
        </div>
      )}
      {guide.fields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint}>
          <input className="input mono" type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
            placeholder={f.placeholder} value={secrets[f.key] || ""}
            onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))} />
        </Field>
      ))}
      <Field label="Name" hint="Only for you, to tell connections apart.">
        <input className="input" placeholder={guide.name} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {problem && <p className="form-problem" role="alert">{problem}</p>}
    </Modal>
  );
}

/** After adding a phone line: attach it to agents that don't have one yet. */
function AttachLine({ line, onClose }: { line: Connection; onClose: () => void }) {
  const agents = useAsync(() => api.agents(), []);
  const [attached, setAttached] = useState<string[]>([]);
  const toast = useToast();
  const waiting = (agents.data || []).filter((a) => !a.telephony_connection_id || attached.includes(a.id));

  async function attach(id: string) {
    try { await api.updateAgent(id, { telephony_connection_id: line.id }); setAttached((x) => [...x, id]); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Modal title="Phone line added" onClose={onClose}
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p style={{ marginTop: 0 }}>
        Agents need a phone line to make real calls. Choose which of yours should use <strong>{line.name}</strong>.
      </p>
      {agents.loading ? <Spinner /> : !waiting.length ? (
        <p className="muted">Every agent already has a phone line. You can change it from Agents → Edit.</p>
      ) : (
        <ul className="attach-list">
          {waiting.map((a) => (
            <li key={a.id}>
              <span><strong>{a.name}</strong>{a.company ? <span className="muted"> · {a.company}</span> : null}</span>
              {attached.includes(a.id)
                ? <span className="badge completed"><span className="dot" />Uses this line</span>
                : <button className="btn btn-ghost btn-sm" onClick={() => attach(a.id)}>Use this line</button>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
