import { Link } from "react-router-dom";
import { api } from "../api";
import { Page, useAsync } from "../hooks";
import { Badge, Spinner, Empty, fmtDur, timeAgo, shortId } from "../ui";

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--pine)", failed: "var(--rust)", in_progress: "var(--amber)",
  dialing: "var(--amber)", queued: "var(--slate)", reserved: "var(--slate)",
};

export default function Overview() {
  const stats = useAsync(() => api.stats(), []);
  const recent = useAsync(() => api.calls({ limit: 6 }), []);

  return (
    <Page title="Overview" sub="Your account at a glance — this calendar month.">
      {stats.loading ? (
        <Spinner />
      ) : stats.error ? (
        <div className="card card-pad" style={{ color: "var(--rust)" }}>{stats.error}</div>
      ) : stats.data && (
        <>
          <div className="grid cols-4">
            <Stat label="Total calls" value={String(stats.data.total_calls)} />
            <Stat label="Failure rate" value={`${(stats.data.failure_rate * 100).toFixed(1)}`} unit="%"
              accent={stats.data.failure_rate > 0.2 ? "var(--rust)" : undefined} />
            <Stat label="Talk time" value={fmtDur(stats.data.total_seconds)} />
            <Stat label="Avg duration" value={fmtDur(stats.data.avg_seconds)} />
          </div>

          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="card-head"><div className="card-title">Calls by status</div></div>
              <div className="card-pad">
                <Breakdown total={stats.data.total_calls} data={stats.data.by_status} colorFor={(k) => STATUS_COLOR[k] || "var(--ink-3)"} />
              </div>
            </div>
            <div className="card">
              <div className="card-head"><div className="card-title">Failures by error code</div></div>
              <div className="card-pad">
                {Object.keys(stats.data.by_error_code).length === 0
                  ? <Empty title="No failures" hint="Every call this month connected." icon="check" />
                  : <Breakdown total={Object.values(stats.data.by_error_code).reduce((a, b) => a + b, 0)}
                      data={stats.data.by_error_code} colorFor={() => "var(--rust)"} />}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <div className="card-title">Recent calls</div>
              <Link to="/calls" className="btn btn-ghost btn-sm">View all</Link>
            </div>
            {recent.loading ? <Spinner /> : !recent.data?.length ? (
              <Empty title="No calls yet" hint="Place your first call via POST /v1/calls." icon="calls" />
            ) : (
              <table className="table">
                <thead><tr><th>Call</th><th>To</th><th>Status</th><th>Duration</th><th>When</th></tr></thead>
                <tbody>
                  {recent.data.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => (window.location.href = `/calls/${c.id}`)}>
                      <td className="mono">{shortId(c.id)}</td>
                      <td className="mono muted">{c.to_number || c.from_number || "—"}</td>
                      <td><Badge status={c.status} /></td>
                      <td className="num muted">{fmtDur(c.duration_seconds)}</td>
                      <td className="muted">{timeAgo(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </Page>
  );
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: accent } : undefined}>
        {value}{unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

function Breakdown({ total, data, colorFor }: { total: number; data: Record<string, number>; colorFor: (k: string) => string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  if (!entries.length) return <Empty title="No data yet" icon="usage" />;
  return (
    <div className="bars">
      {entries.map(([k, v]) => (
        <div className="bar-row" key={k}>
          <div className="bar-label">{k.replace(/_/g, " ")}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(v / max) * 100}%`, background: colorFor(k) }} />
          </div>
          <div className="bar-val">{v}{total ? <span className="dim"> · {Math.round((v / total) * 100)}%</span> : null}</div>
        </div>
      ))}
    </div>
  );
}
