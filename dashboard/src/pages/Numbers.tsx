import { useState } from "react";
import { api, type Agent } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Empty, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

export default function Numbers() {
  const nums = useAsync(() => api.numbers(), []);
  const agents = useAsync(() => api.agents(), []);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name || id.slice(0, 8);

  async function del(id: string) {
    if (!confirm("Release this number mapping?")) return;
    try { await api.deleteNumber(id); nums.reload(); toast("Removed"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Phone Numbers" sub="Route inbound calls on a number to one of your agents."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> Map number</button>}>
      <div className="card">
        {nums.loading ? <Spinner /> : !nums.data?.length ? (
          <Empty title="No numbers mapped" hint="Point a number's answer URL at /v1/telephony/inbound." icon="numbers" />
        ) : (
          <table className="table">
            <thead><tr><th>Number</th><th>Routes to agent</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {nums.data.map((n) => (
                <tr key={n.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{n.e164}</td>
                  <td><span className="badge clay">{agentName(n.agent_id)}</span></td>
                  <td className="muted">{fmtDate(n.created_at)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(n.id)}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <CreateModal agents={agents.data || []} onClose={() => setOpen(false)} onDone={() => { setOpen(false); nums.reload(); }} />}
    </Page>
  );
}

function CreateModal({ agents, onClose, onDone }: { agents: Agent[]; onClose: () => void; onDone: () => void }) {
  const [e164, setE164] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    try { await api.createNumber({ e164, agent_id: agentId }); toast("Number mapped"); onDone(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Map a phone number" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !e164 || !agentId}>{busy ? "Saving…" : "Map number"}</button>
      </>}>
      <Field label="Number (E.164)"><input className="input mono" placeholder="+14155550123" value={e164} onChange={(e) => setE164(e.target.value)} /></Field>
      <Field label="Agent">
        <Select value={agentId} onChange={setAgentId} placeholder="— select agent —"
          emptyText="No agents yet — create one first"
          options={agents.map((a) => ({ value: a.id, label: a.name }))} />
      </Field>
    </Modal>
  );
}
