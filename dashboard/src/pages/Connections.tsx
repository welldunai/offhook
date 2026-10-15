import { useState } from "react";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Empty, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

const KINDS = ["stt", "tts", "llm", "telephony"];
const KIND_LABEL: Record<string, string> = { stt: "Speech-to-text", tts: "Text-to-speech", llm: "Language model", telephony: "Telephony" };

export default function Connections() {
  const conns = useAsync(() => api.connections(), []);
  const provs = useAsync(() => api.providers(), []);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  const supported = (provs.data?.supported as Record<string, string[]>) || {};

  async function del(id: string) {
    if (!confirm("Delete this connection?")) return;
    try { await api.deleteConnection(id); conns.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Connections" sub="Bring your own provider keys — stored encrypted, never shown again."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> New connection</button>}>
      <div className="card">
        {conns.loading ? <Spinner /> : !conns.data?.length ? (
          <Empty title="No connections" hint="Add provider keys to power your agents." icon="connections" />
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
      {open && <CreateModal supported={supported} onClose={() => setOpen(false)} onDone={() => { setOpen(false); conns.reload(); }} />}
    </Page>
  );
}

function CreateModal({ supported, onClose, onDone }: { supported: Record<string, string[]>; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState("llm");
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const options = supported[kind] || [];
  const prov = provider || options[0] || "";
  const SECRET_FIELDS: Record<string, string[]> = {
    plivo: ["auth_id", "auth_token", "from_number"],
    twilio: ["account_sid", "auth_token", "from_number"],
  };
  const fields = SECRET_FIELDS[prov] || ["api_key"];

  async function save() {
    setBusy(true);
    try {
      await api.createConnection({ name: name || `${prov}-key`, provider_kind: kind, provider_name: prov, secrets });
      toast("Connection added"); onDone();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title="New connection" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !prov}>{busy ? "Saving…" : "Add connection"}</button>
      </>}>
      <Field label="Type">
        <Select value={kind} onChange={(v) => { setKind(v); setProvider(""); setSecrets({}); }}
          options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </Field>
      <Field label="Provider">
        <Select value={prov} onChange={(v) => { setProvider(v); setSecrets({}); }}
          options={options.map((o) => ({ value: o, label: o }))} placeholder="— select provider —" />
      </Field>
      <Field label="Name"><input className="input" placeholder={`${prov}-key`} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      {fields.map((f) => (
        <Field key={f} label={f.replace(/_/g, " ")}>
          <input className="input mono" type={f.includes("token") || f.includes("key") ? "password" : "text"}
            value={secrets[f] || ""} onChange={(e) => setSecrets((s) => ({ ...s, [f]: e.target.value }))} />
        </Field>
      ))}
    </Modal>
  );
}
