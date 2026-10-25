import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Agent } from "../api";
import { Page, useAsync } from "../hooks";
import { Badge, Spinner, Empty, Icon, Modal, Field, Select, fmtDur, fmtDate, shortId, useToast } from "../ui";

const STATUS_OPTS = [
  { value: "", label: "All statuses" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "in_progress", label: "In progress" },
  { value: "dialing", label: "Dialing" },
  { value: "queued", label: "Queued" },
];
const DIRECTION_OPTS = [
  { value: "", label: "All directions" },
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
  { value: "web", label: "Web" },
];

export default function Calls() {
  const [status, setStatus] = useState("");
  const [direction, setDirection] = useState("");
  const [search, setSearch] = useState("");
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [placing, setPlacing] = useState(false);
  const [page, setPage] = useState(0);
  const nav = useNavigate();
  const PAGE_SIZE = 10;

  // Changing a filter resets to the first page.
  const onStatus = (v: string) => { setStatus(v); setPage(0); };
  const onDirection = (v: string) => { setDirection(v); setPage(0); };

  const addTag = (raw: string) => {
    const t = raw.trim();
    if (!t.includes(":") || t.startsWith(":")) return;       // expect key:value
    if (!tagFilters.includes(t)) setTagFilters((f) => [...f, t]);
    setTagDraft(""); setPage(0);
  };
  const removeTag = (t: string) => { setTagFilters((f) => f.filter((x) => x !== t)); setPage(0); };

  const { data, loading, error, reload } = useAsync(
    () => api.calls({
      status: status || undefined, direction: direction || undefined,
      tags: tagFilters.length ? tagFilters : undefined,
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    }),
    [status, direction, tagFilters, page]
  );

  // Search filters the current page client-side.
  const rows = (data || []).filter((c) =>
    !search || (c.to_number || "").includes(search) || (c.from_number || "").includes(search) || c.id.includes(search)
  );
  const hasNext = (data?.length || 0) === PAGE_SIZE;

  return (
    <Page title="Calls" sub="Every call placed or received — searchable activity log."
      actions={<>
        <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="refresh" size={14} /> Refresh</button>
        <button className="btn btn-primary btn-sm" onClick={() => setPlacing(true)}><Icon name="calls" size={14} /> New call</button>
      </>}>
      <div className="card">
        <div className="card-head" style={{ flexWrap: "wrap", gap: 10 }}>
          <div className="wrap" style={{ gap: 8 }}>
            <div style={{ width: 150 }}><Select value={status} onChange={onStatus} options={STATUS_OPTS} /></div>
            <div style={{ width: 150 }}><Select value={direction} onChange={onDirection} options={DIRECTION_OPTS} /></div>
          </div>
          <div className="wrap" style={{ gap: 8 }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: 9, color: "var(--ink-3)" }}><Icon name="search" size={15} /></span>
              <input className="input" style={{ width: 200, paddingLeft: 32 }} placeholder="Number or call ID"
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <input className="input" style={{ width: 200 }} placeholder="Tag, e.g. region:North"
              value={tagDraft} onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagDraft); } }} />
          </div>
        </div>
        {tagFilters.length > 0 && (
          <div className="wrap" style={{ padding: "12px 16px", gap: 6, alignItems: "center" }}>
            <span className="dim" style={{ fontSize: 12 }}>Filtering by</span>
            {tagFilters.map((t) => (
              <span key={t} className="badge clay mono" style={{ padding: "2px 4px 2px 9px", gap: 4, fontSize: 11.5 }}>
                {t}
                <button onClick={() => removeTag(t)} title="Remove filter" aria-label={`Remove filter ${t}`}
                  className="tag-x">×</button>
              </span>
            ))}
            <button className="btn-link" onClick={() => { setTagFilters([]); setPage(0); }}
              style={{ fontSize: 11.5 }}>clear</button>
          </div>
        )}

        {loading ? <Spinner /> : error ? (
          <div className="card-pad" style={{ color: "var(--rust)" }}>{error}</div>
        ) : !rows.length ? (
          <Empty title={page > 0 ? "No calls on this page" : "No calls match"}
            hint={page > 0 ? "Go back a page." : "Place a call or clear the filters."} icon="calls" />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Call ID</th><th>Direction</th><th>To / From</th><th>Status</th><th>Tags</th><th>Error</th><th>Duration</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => nav(`/calls/${c.id}`)}>
                  <td className="mono">{shortId(c.id)}</td>
                  <td><span className="badge neutral">{c.direction}</span></td>
                  <td className="mono muted">{c.direction === "inbound" ? c.from_number : c.to_number || "—"}</td>
                  <td><Badge status={c.status} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {c.tags && Object.keys(c.tags).length ? (
                      <span className="wrap" style={{ gap: 4 }}>
                        {Object.entries(c.tags).map(([k, v]) => (
                          <button key={k} className="badge neutral mono" title={`Filter by ${k}:${v}`}
                            onClick={() => addTag(`${k}:${v}`)}
                            style={{ border: "none", cursor: "pointer", fontSize: 11 }}>{k}:{v}</button>
                        ))}
                      </span>
                    ) : <span className="dim">—</span>}
                  </td>
                  <td>{c.error_code ? <span className="badge failed" style={{ background: "var(--rust-soft)", color: "var(--rust)" }}>{c.error_code}</span> : <span className="dim">—</span>}</td>
                  <td className="num muted">{fmtDur(c.duration_seconds)}</td>
                  <td className="muted">{fmtDate(c.created_at)}</td>
                  <td className="dim"><Icon name="back" size={14} className="" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !error && rows.length > 0 && (
          <div className="between" style={{ padding: "12px 16px", borderTop: "1px solid var(--line-2)" }}>
            <span className="dim" style={{ fontSize: 13 }}>
              Page {page + 1} · {rows.length} calls
            </span>
            <div className="row">
              <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <Icon name="back" size={13} /> Prev
              </button>
              <button className="btn btn-ghost btn-sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                Next <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}><Icon name="back" size={13} /></span>
              </button>
            </div>
          </div>
        )}
      </div>
      {placing && <PlaceCallModal onClose={() => setPlacing(false)} onPlaced={(id) => { setPlacing(false); reload(); nav(`/calls/${id}`); }} />}
    </Page>
  );
}

function PlaceCallModal({ onClose, onPlaced }: { onClose: () => void; onPlaced: (id: string) => void }) {
  const agents = useAsync(() => api.agents(), []);
  const [agentId, setAgentId] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [context, setContext] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function place() {
    let ctx: Record<string, unknown> | undefined;
    if (context.trim()) {
      try { ctx = JSON.parse(context); }
      catch { toast("Context must be valid JSON"); return; }
    }
    let tagObj: Record<string, string> | undefined;
    if (tags.trim()) {
      try {
        const parsed = JSON.parse(tags);
        if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        tagObj = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
      } catch { toast("Tags must be a JSON object of string values"); return; }
    }
    setBusy(true);
    try {
      const r = await api.createCall({ agent_id: agentId, to_number: toNumber, context: ctx, tags: tagObj });
      toast("Call queued"); onPlaced(r.id);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Place a call" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={place} disabled={busy || !agentId || !toNumber}>
          {busy ? "Placing…" : "Place call"}
        </button>
      </>}>
      <Field label="Agent">
        <Select value={agentId} onChange={setAgentId} placeholder="— select agent —"
          emptyText="No agents yet — create one first"
          options={(agents.data || []).map((a: Agent) => ({ value: a.id, label: a.name }))} />
      </Field>
      <Field label="To number" hint="Destination in E.164 format.">
        <input className="input mono" placeholder="+14155550123" value={toNumber} onChange={(e) => setToNumber(e.target.value)} />
      </Field>
      <Field label="Context (JSON)" hint="Optional facts injected into the agent's prompt.">
        <textarea className="input mono" placeholder={'{ "name": "Priya" }'} value={context} onChange={(e) => setContext(e.target.value)} />
      </Field>
      <Field label="Tags (JSON)" hint="Optional labels for searching this call later, e.g. region or motive.">
        <textarea className="input mono" placeholder={'{ "region": "North", "motive": "sales" }'} value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
    </Modal>
  );
}

