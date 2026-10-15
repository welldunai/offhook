import { useState } from "react";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Spinner, Empty, Modal, Field, Select, Icon, fmtDate, useToast } from "../ui";

export default function Tools() {
  const tools = useAsync(() => api.tools(), []);
  const [open, setOpen] = useState(false);
  const toast = useToast();

  async function del(id: string) {
    if (!confirm("Delete this tool? Agents using it will stop calling it.")) return;
    try { await api.deleteTool(id); tools.reload(); toast("Deleted"); }
    catch (e) { toast((e as Error).message); }
  }

  return (
    <Page title="Tools" sub="Functions the agent can call mid-call to fetch live data from your APIs."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Icon name="plus" size={15} /> New tool</button>}>
      <div className="card">
        {tools.loading ? <Spinner /> : !tools.data?.length ? (
          <Empty title="No tools yet" hint="Define an HTTP tool so the agent can look things up during a call." icon="tools" />
        ) : (
          <table className="table">
            <thead><tr><th>Name</th><th>Method</th><th>Endpoint</th><th>Auth</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {tools.data.map((t) => (
                <tr key={t.id}>
                  <td className="mono" style={{ fontWeight: 600 }}>{t.name}</td>
                  <td><span className="badge neutral">{t.method}</span></td>
                  <td className="mono muted" style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.url}</td>
                  <td>{t.has_auth ? <span className="badge ok" style={{ fontSize: 10.5 }}>headers set</span> : <span className="dim">—</span>}</td>
                  <td className="muted">{fmtDate(t.created_at)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => del(t.id)}><Icon name="trash" size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <CreateModal onClose={() => setOpen(false)} onDone={() => { setOpen(false); tools.reload(); }} />}
    </Page>
  );
}

type Param = { name: string; type: string; description: string; required: boolean };
type Header = { key: string; value: string };

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  const [timeout, setTimeout] = useState(10);
  const [params, setParams] = useState<Param[]>([{ name: "", type: "string", description: "", required: true }]);
  const [headers, setHeaders] = useState<Header[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const setParam = (i: number, patch: Partial<Param>) =>
    setParams((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setHeader = (i: number, patch: Partial<Header>) =>
    setHeaders((h) => h.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of params) {
      if (!p.name.trim()) continue;
      properties[p.name.trim()] = { type: p.type, description: p.description || undefined };
      if (p.required) required.push(p.name.trim());
    }
    const hdrs: Record<string, string> = {};
    for (const h of headers) if (h.key.trim()) hdrs[h.key.trim()] = h.value;

    setBusy(true);
    try {
      await api.createTool({
        name: name.trim(), description, method, url: url.trim(),
        parameters: { properties, required }, headers: hdrs, timeout_seconds: timeout,
      });
      toast("Tool created"); onDone();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  const ready = name.trim() && description.trim() && url.trim();

  return (
    <Modal title="New tool" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={busy || !ready}>{busy ? "Saving…" : "Create tool"}</button>
      </>}>
      <Field label="Function name" hint="What the model calls. Identifier only, e.g. check_order_status.">
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="check_order_status" />
      </Field>
      <Field label="Description" hint="Tell the model when to use it — this drives whether it gets called.">
        <textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Look up an order by its ID and return its status, items, and delivery date." />
      </Field>

      <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div style={{ width: 120 }}>
          <Field label="Method">
            <Select value={method} onChange={setMethod} options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }]} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Endpoint URL" hint="Use {param} to drop an argument into the path.">
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.yourapp.com/orders/{order_id}" />
          </Field>
        </div>
      </div>

      <Field label="Parameters" hint="The arguments the model fills in. Path {params} go in the URL; the rest become the query (GET) or JSON body (POST).">
        <div style={{ display: "grid", gap: 8 }}>
          {params.map((p, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input className="input mono" style={{ flex: 1.2 }} placeholder="order_id"
                value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} />
              <div style={{ width: 110 }}>
                <Select value={p.type} onChange={(v) => setParam(i, { type: v })}
                  options={["string", "number", "boolean"].map((t) => ({ value: t, label: t }))} />
              </div>
              <input className="input" style={{ flex: 1.6 }} placeholder="description"
                value={p.description} onChange={(e) => setParam(i, { description: e.target.value })} />
              <label className="row dim" style={{ gap: 4, fontSize: 12, whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} /> req
              </label>
              <button className="btn btn-ghost btn-sm" onClick={() => setParams((x) => x.filter((_, j) => j !== i))}><Icon name="trash" size={12} /></button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }}
            onClick={() => setParams((p) => [...p, { name: "", type: "string", description: "", required: true }])}>
            <Icon name="plus" size={12} /> Add parameter
          </button>
        </div>
      </Field>

      <Field label="Auth headers" hint="Sent with every request. Encrypted at rest, never shown again.">
        <div style={{ display: "grid", gap: 8 }}>
          {headers.map((h, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input className="input mono" style={{ flex: 1 }} placeholder="Authorization"
                value={h.key} onChange={(e) => setHeader(i, { key: e.target.value })} />
              <input className="input mono" style={{ flex: 1.4 }} type="password" placeholder="Bearer …"
                value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
              <button className="btn btn-ghost btn-sm" onClick={() => setHeaders((x) => x.filter((_, j) => j !== i))}><Icon name="trash" size={12} /></button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }}
            onClick={() => setHeaders((h) => [...h, { key: "", value: "" }])}>
            <Icon name="plus" size={12} /> Add header
          </button>
        </div>
      </Field>

      <Field label="Timeout (seconds)" hint="1–20. The call waits this long for your API before giving up.">
        <input className="input mono" type="number" min={1} max={20} value={timeout}
          onChange={(e) => setTimeout(Math.min(20, Math.max(1, Number(e.target.value) || 10)))} style={{ width: 100 }} />
      </Field>
    </Modal>
  );
}
