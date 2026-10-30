import { useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE, api, type Agent, type Connection } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

const INBOUND_URL = `${API_BASE}/v1/telephony/inbound`;
const E164 = /^\+[1-9]\d{6,14}$/;

/** How to send a number's incoming calls to Offhook, per carrier. */
const CARRIER_STEPS: Record<string, { name: string; steps: string[]; url: string }> = {
  twilio: {
    name: "Twilio",
    url: "https://console.twilio.com/us1/develop/phone-numbers/manage/incoming",
    steps: [
      "In Twilio, open Phone Numbers → Manage → Active numbers and click your number.",
      "Under Voice Configuration, set “A call comes in” to Webhook, paste the address above, and choose HTTP POST.",
      "Set “Primary handler fails” to the same address, also HTTP POST. If Offhook was asleep, the first try wakes it and the second answers.",
      "Save the configuration.",
    ],
  },
  plivo: {
    name: "Plivo",
    url: "https://console.plivo.com/voice/applications/",
    steps: [
      "In Plivo, open Voice → Applications → New Application. Paste the address above as the Answer URL and as the Fallback Answer URL, both with method POST, and save. (If Offhook was asleep, the first try wakes it and the fallback answers.)",
      "Open Phone Numbers → Your Numbers, click your number, choose XML Application, pick the application you just made, and update.",
    ],
  },
};

export default function Numbers() {
  const nums = useAsync(() => api.numbers(), []);
  const agents = useAsync(() => api.agents(), []);
  const conns = useAsync(() => api.connections(), []);
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const agentName = (id: string) => agents.data?.find((a) => a.id === id)?.name || id.slice(0, 8);

  async function del(id: string) {
    if (!confirm("Stop routing this number to its agent?")) return;
    try { await api.deleteNumber(id); nums.reload(); toast("Removed"); }
    catch (e) { toast((e as Error).message); }
  }

  const lines = (conns.data || []).filter((c) => c.provider_kind === "telephony");
  const carriers = [...new Set(lines.map((c) => c.provider_name))].filter((p) => p in CARRIER_STEPS);

  return (
    <Page title="Phone numbers" sub="Let people call your agents: incoming calls to a number are answered by the agent you choose."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> Assign a number</button>}>
      <InboundSetup carriers={carriers.length ? carriers : ["twilio", "plivo"]} hasLine={lines.length > 0} />
      <div className="card" style={{ marginTop: 16 }}>
        {nums.loading ? <Spinner /> : !nums.data?.length ? (
          <div className="empty">
            <div style={{ fontWeight: 600, color: "var(--ink)", marginBottom: 6 }}>No numbers assigned yet</div>
            <div style={{ marginBottom: 14 }}>Assign one of your Twilio or Plivo numbers to an agent, then point it at Offhook (above).</div>
            <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Assign a number</button>
          </div>
        ) : (
          <table className="table">
            <thead><tr><th>Number</th><th>Answered by</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {nums.data.map((n) => (
                <tr key={n.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{n.e164}</td>
                  <td><span className="badge clay">{agentName(n.agent_id)}</span></td>
                  <td className="muted">{fmtDate(n.created_at)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(n.id)} aria-label={`Remove ${n.e164}`}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <AssignModal agents={agents.data || []} lines={lines} onClose={() => setOpen(false)} onDone={() => { setOpen(false); nums.reload(); }} />}
    </Page>
  );
}

/** The one-time carrier setup: the address to paste, and where. */
function InboundSetup({ carriers, hasLine }: { carriers: string[]; hasLine: boolean }) {
  const [carrier, setCarrier] = useState(carriers[0]);
  const toast = useToast();
  const guide = CARRIER_STEPS[carrier] ?? CARRIER_STEPS.twilio;
  return (
    <section className="card card-pad inbound">
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 className="card-title" style={{ fontSize: 17 }}>Send a number's calls to Offhook</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            {hasLine ? "Do this once for each number, at your carrier." : <>First <Link to="/connections?new=telephony" className="link">add a phone line</Link> and give it to an agent. Then, for each number:</>}
          </p>
        </div>
        {carriers.length > 1 && (
          <div className="pill-toggle" role="tablist" aria-label="Carrier">
            {carriers.map((c) => (
              <button key={c} role="tab" aria-selected={c === carrier} className={c === carrier ? "on" : ""} onClick={() => setCarrier(c)}>
                {CARRIER_STEPS[c].name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="inbound-url">
        <code>{INBOUND_URL}</code>
        <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard.writeText(INBOUND_URL); toast("Address copied"); }}>
          <Icon name="copy" size={13} /> Copy
        </button>
      </div>
      <ol className="guide-steps" style={{ marginTop: 12 }}>
        {guide.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <a className="guide-link" href={guide.url} target="_blank" rel="noreferrer">Open {guide.name} <Icon name="ext" size={13} /></a>
    </section>
  );
}

/** Assign a number to an agent. Only agents with a phone line can answer calls. */
function AssignModal({ agents, lines, onClose, onDone }: { agents: Agent[]; lines: Connection[]; onClose: () => void; onDone: () => void }) {
  const [e164, setE164] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = agents.filter((a) => a.telephony_connection_id);
  const notReady = agents.filter((a) => !a.telephony_connection_id);

  async function save() {
    const number = e164.replace(/[\s()-]/g, "");
    if (!E164.test(number)) return setProblem("Use the full international format, like +14155550123.");
    setBusy(true);
    try { await api.createNumber({ e164: number, agent_id: agentId }); onDone(); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Assign a number" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !e164 || !agentId}>{busy ? "Saving…" : "Assign"}</button>
      </>}>
      <Field label="Number" hint="One of your Twilio or Plivo numbers, in international format.">
        <input className="input mono" placeholder="+14155550123" value={e164} onChange={(e) => setE164(e.target.value)} />
      </Field>
      <Field label="Answered by" hint={!lines.length ? "Add a phone line first (Connections), then give it to an agent." : notReady.length ? `${notReady.map((a) => a.name).join(", ")} can't take calls yet: no phone line. Add one from Agents → Edit.` : undefined}>
        <Select value={agentId} onChange={setAgentId} placeholder="Choose an agent"
          emptyText="No agent has a phone line yet."
          options={ready.map((a) => ({ value: a.id, label: a.name }))} />
      </Field>
      {problem && <p className="form-problem" role="alert">{problem}</p>}
    </Modal>
  );
}
