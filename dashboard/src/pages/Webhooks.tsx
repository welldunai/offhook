import { useState } from "react";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Empty, Modal, Field, Icon, Badge, fmtDate, useToast } from "../ui";

export default function Webhooks() {
  const hooks = useAsync(() => api.webhooks(), []);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const toast = useToast();

  async function del(id: string) {
    if (!confirm("Delete this webhook?")) return;
    try { await api.deleteWebhook(id); hooks.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Webhooks" sub="Signed event callbacks — call.queued, dialing, completed, failed, and more."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> New endpoint</button>}>
      <div className="card">
        {hooks.loading ? <Spinner /> : !hooks.data?.length ? (
          <Empty title="No webhooks" hint="Add an endpoint to receive call events." icon="webhooks" />
        ) : (
          <table className="table">
            <thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {hooks.data.map((w) => (
                <tr key={w.id}>
                  <td className="mono" style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.url}</td>
                  <td className="muted">{w.events.length ? w.events.join(", ") : "all events"}</td>
                  <td>{w.enabled ? <Badge status="completed">enabled</Badge> : <Badge status="reserved">paused</Badge>}</td>
                  <td className="muted">{fmtDate(w.created_at)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(w.id)}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <CreateModal onClose={() => setOpen(false)} onDone={(s) => { setOpen(false); setSecret(s); hooks.reload(); }} />}
      {secret && (
        <Modal title="Signing secret" onClose={() => setSecret(null)} footer={<button className="btn btn-dark" onClick={() => setSecret(null)}>Done</button>}>
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>Use this to verify the <span className="mono">X-Voice-Signature</span> header. Shown once.</p>
          <div className="secret">
            <span>{secret}</span>
            <button className="btn btn-sm" style={{ background: "rgba(255,255,255,.12)", color: "#fff", flexShrink: 0 }}
              onClick={() => { navigator.clipboard.writeText(secret); toast("Copied"); }}><Icon name="copy" size={13} /></button>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: (secret: string) => void }) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    try {
      const r = await api.createWebhook({ url, events: events.split(",").map((s) => s.trim()).filter(Boolean) });
      toast("Webhook added"); onDone(r.secret);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title="New webhook endpoint" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !url}>{busy ? "Saving…" : "Add endpoint"}</button>
      </>}>
      <Field label="URL" hint="Must be a public https endpoint."><input className="input mono" placeholder="https://you.example.com/hook" value={url} onChange={(e) => setUrl(e.target.value)} /></Field>
      <Field label="Events" hint="Comma-separated, or leave blank for all."><input className="input mono" placeholder="call.completed, call.failed" value={events} onChange={(e) => setEvents(e.target.value)} /></Field>
    </Modal>
  );
}
