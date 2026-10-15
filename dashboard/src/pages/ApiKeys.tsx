import { useState } from "react";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Badge, Spinner, Empty, Modal, Field, Select, Icon, fmtDate, timeAgo, useToast } from "../ui";

export default function ApiKeys() {
  const { data, loading, reload } = useAsync(() => api.apiKeys(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<number | "">("");
  const [created, setCreated] = useState<{ key: string; prefix: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function create() {
    setBusy(true);
    try {
      const r = await api.createApiKey(name || "untitled", expiry === "" ? undefined : expiry);
      setCreated({ key: r.key, prefix: r.prefix });
      setCreating(false); setName(""); setExpiry(""); reload();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  async function revoke(id: string) {
    if (!confirm("Revoke this key? Requests using it will be rejected immediately.")) return;
    await api.revokeApiKey(id); reload(); toast("Key revoked");
  }

  return (
    <Page title="API Keys" sub="Authenticate requests to the Offhook API."
      actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New key</button>}>
      <div className="card">
        {loading ? <Spinner /> : !data?.length ? (
          <Empty title="No API keys" hint="Create one to start making calls." icon="keys" />
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.map((k) => {
                const expired = !!k.expires_at && new Date(k.expires_at) < new Date();
                return (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.name || "untitled"}</td>
                  <td className="mono muted">vk…{k.prefix}</td>
                  <td className="muted">{k.last_used_at ? timeAgo(k.last_used_at) : "never"}</td>
                  <td className="muted">{k.expires_at ? fmtDate(k.expires_at) : <span className="dim">never</span>}</td>
                  <td>{k.revoked_at ? <Badge status="failed">revoked</Badge> : expired ? <Badge status="failed">expired</Badge> : <Badge status="completed">active</Badge>}</td>
                  <td>{!k.revoked_at && (
                    <button className="btn btn-danger btn-sm" onClick={() => revoke(k.id)}><Icon name="trash" size={13} /></button>
                  )}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <Modal title="New API key" onClose={() => setCreating(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={busy}>{busy ? "Creating…" : "Create key"}</button>
          </>}>
          <Field label="Name" hint="A label to recognize this key later."><input className="input" placeholder="production backend" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Expiry" hint="The key stops working after this period.">
            <Select value={expiry === "" ? "" : String(expiry)}
              onChange={(v) => setExpiry(v === "" ? "" : Number(v))}
              options={[
                { value: "", label: "Never" },
                { value: "7", label: "7 days" },
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
              ]} />
          </Field>
        </Modal>
      )}

      {created && (
        <Modal title="Save your API key" onClose={() => setCreated(null)}
          footer={<button className="btn btn-dark" onClick={() => setCreated(null)}>Done</button>}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>This is the only time the full key is shown. Store it somewhere safe.</p>
          <div className="secret">
            <span>{created.key}</span>
            <button className="btn btn-sm" style={{ background: "rgba(255,255,255,.12)", color: "#fff", flexShrink: 0 }}
              onClick={() => { navigator.clipboard.writeText(created.key); toast("Copied"); }}><Icon name="copy" size={13} /></button>
          </div>
        </Modal>
      )}
    </Page>
  );
}
