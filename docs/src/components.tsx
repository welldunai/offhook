import { useState, type ReactNode } from "react";

/* ---------- syntax highlighting (author-controlled content only) ---------- */
function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function hlJson(src: string): string {
  let out = "", i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && !(src[j] === '"' && src[j - 1] !== "\\")) j++;
      const str = src.slice(i, j + 1);
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      out += `<span class="${src[k] === ":" ? "tok-key" : "tok-str"}">${esc(str)}</span>`;
      i = j + 1;
    } else if (/[0-9]/.test(ch) && /[\s:[,]/.test(src[i - 1] || " ")) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      out += `<span class="tok-num">${src.slice(i, j)}</span>`; i = j;
    } else if (/^(true|false|null)/.test(src.slice(i))) {
      const m = src.slice(i).match(/^(true|false|null)/)![1];
      out += `<span class="tok-bool">${m}</span>`; i += m.length;
    } else if ("{}[]:,".includes(ch)) {
      out += `<span class="tok-punc">${ch}</span>`; i++;
    } else { out += esc(ch); i++; }
  }
  return out;
}
function hlBash(src: string): string {
  return src.split("\n").map((line) => {
    if (line.trim().startsWith("#")) return `<span class="tok-com">${esc(line)}</span>`;
    let s = esc(line);
    s = s.replace(/('[^']*'|"[^"]*")/g, '<span class="tok-str">$1</span>');
    s = s.replace(/(^|\s)(-{1,2}[A-Za-z][\w-]*)/g, '$1<span class="tok-flag">$2</span>');
    s = s.replace(/^(\s*)(curl|export|python|npm|cd|pip)\b/, '$1<span class="tok-cmd">$2</span>');
    return s;
  }).join("\n");
}

type Tab = { label: string; lang: "bash" | "json" | "text"; code: string };
export function Code({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const t = tabs[active];
  const html = t.lang === "json" ? hlJson(t.code) : t.lang === "bash" ? hlBash(t.code) : esc(t.code);
  return (
    <div className="code">
      <div className="code-head">
        {tabs.map((tb, i) => (
          <button key={i} className={`code-tab${i === active ? " on" : ""}`} onClick={() => setActive(i)}>{tb.label}</button>
        ))}
        <button className="code-copy" onClick={() => { navigator.clipboard.writeText(t.code); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function Method({ m }: { m: string }) {
  return <span className={`method ${m.toLowerCase()}`}>{m}</span>;
}

export function Endpoint({ method, path }: { method: string; path: string }) {
  const parts = path.split(/(\{[^}]+\})/g);
  return (
    <div className="endpoint">
      <Method m={method} />
      <span className="path">{parts.map((p, i) => p.startsWith("{") ? <span className="dim" key={i}>{p}</span> : <span key={i}>{p}</span>)}</span>
    </div>
  );
}

export type Param = { name: string; type: string; required?: boolean; desc: ReactNode };
export function Params({ title = "Body parameters", rows }: { title?: string; rows: Param[] }) {
  return (
    <>
      <h3>{title}</h3>
      <table className="ptable">
        <thead><tr><th style={{ width: "26%" }}>Field</th><th style={{ width: "20%" }}>Type</th><th>Description</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td><span className="pname">{r.name}</span>{r.required ? <span className="req">required</span> : <span className="opt">optional</span>}</td>
              <td><span className="ptype">{r.type}</span></td>
              <td>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function Callout({ kind = "tip", children }: { kind?: "tip" | "note" | "warn"; children: ReactNode }) {
  return <div className={`callout ${kind}`}>{children}</div>;
}
