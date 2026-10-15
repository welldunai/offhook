import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";

/* ---------------- icons ---------------- */
const P = ({ d }: { d: string }) => <path d={d} />;
const paths: Record<string, ReactNode> = {
  overview: <P d="M3 13a9 9 0 0 1 18 0M12 13l4-3" />,
  calls: <P d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5L14 12l4 1.5V17a2 2 0 0 1-2 2A13 13 0 0 1 3 6a2 2 0 0 1 2-2Z" />,
  keys: <P d="M14 7a3 3 0 1 1-3 3M11 10l-7 7v3h3v-2h2v-2h2l1-1" />,
  connections: <P d="M9 7V4M15 7V4M7 7h10v3a5 5 0 0 1-10 0V7ZM12 15v5" />,
  agents: <P d="M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 20a7 7 0 0 1 14 0" />,
  webhooks: <P d="M5 12a7 7 0 0 1 12-5M12 12a3 3 0 1 0 3 3h5M9 14l-4 6" />,
  numbers: <P d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15" />,
  usage: <P d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-8" />,
  logout: <P d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M9 12h11l-3-3M20 12l-3 3" />,
  plus: <P d="M12 5v14M5 12h14" />,
  copy: <P d="M9 9h10v10H9zM5 15V5h10" />,
  trash: <P d="M5 7h14M10 11v5M14 11v5M6 7l1 12h10l1-12M9 7V4h6v3" />,
  search: <P d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM21 21l-5-5" />,
  back: <P d="M15 5l-7 7 7 7" />,
  ext: <P d="M14 5h5v5M19 5l-8 8M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />,
  check: <P d="M5 12l5 5 9-11" />,
  chev: <P d="M6 9l6 6 6-6" />,
  refresh: <P d="M4 9a8 8 0 0 1 14-3l2 2M20 15a8 8 0 0 1-14 3l-2-2M18 4v4h-4M6 20v-4h4" />,
  wave: <P d="M2 12h3l2-7 4 14 3-11 2 6 2-2h4" />,
  doc: <P d="M7 3h7l4 4v14H7zM14 3v4h4" />,
  tools: <P d="M14 6a3.5 3.5 0 0 0 4.5 4.5L21 13l-3 3-2.5-2.5A3.5 3.5 0 0 0 11 9L4 16l-1-1 7-7a3.5 3.5 0 0 1 4-2Z" />,
};
export function Icon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

/* ---------------- primitives ---------------- */
export function Badge({ status, children }: { status: string; children?: ReactNode }) {
  return (
    <span className={`badge ${status}`}>
      <span className="dot" /> {children ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Spinner() {
  return <div className="loading-wrap"><div className="spinner" /></div>;
}

export function Empty({ title, hint, icon = "doc" }: { title: string; hint?: string; icon?: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={38} className="empty-ico" />
      <div style={{ fontWeight: 600, color: "var(--ink-2)" }}>{title}</div>
      {hint && <div style={{ marginTop: 4, fontSize: 13 }}>{hint}</div>}
    </div>
  );
}

export type Option = { value: string; label: string };
export function Select({ value, onChange, options, placeholder = "— select —", emptyText = "No options yet" }:
  { value: string; onChange: (v: string) => void; options: Option[]; placeholder?: string; emptyText?: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const sel = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = (v: string) => { onChange(v); setOpen(false); };

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") return setOpen(false);
    if (!open && ["ArrowDown", "Enter", " "].includes(e.key)) {
      e.preventDefault(); setOpen(true);
      setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    } else if (open) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
      else if (e.key === "Enter") { e.preventDefault(); if (options[hi]) choose(options[hi].value); }
    }
  }

  return (
    <div className="cselect" ref={ref}>
      <button type="button" className={`cselect-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKey} aria-haspopup="listbox" aria-expanded={open}>
        <span className={sel ? "" : "placeholder"}>{sel ? sel.label : placeholder}</span>
        <Icon name="chev" size={15} className="cselect-chevron" />
      </button>
      {open && (
        <div className="cselect-menu" role="listbox">
          {options.length === 0 ? (
            <div className="cselect-empty">{emptyText}</div>
          ) : options.map((o, i) => (
            <div key={o.value || "_"} role="option" aria-selected={o.value === value}
              className={`cselect-opt${o.value === value ? " sel" : ""}${i === hi ? " hi" : ""}`}
              onMouseEnter={() => setHi(i)} onClick={() => choose(o.value)}>
              <span>{o.label}</span>
              <Icon name="check" size={15} className="check" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="modal-title">{title}</div></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- toast ---------------- */
const ToastCtx = createContext<(m: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------------- formatters ---------------- */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}
export function shortId(id: string): string {
  return id.slice(0, 8);
}
