import { Routes, Route, NavLink, Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import Introduction from "./pages/Introduction";
import Quickstart from "./pages/Quickstart";
import Authentication from "./pages/Authentication";
import Connections from "./pages/Connections";
import Agents from "./pages/Agents";
import Tools from "./pages/Tools";
import Calls from "./pages/Calls";
import Webhooks from "./pages/Webhooks";
import Inbound from "./pages/Inbound";
import Logs from "./pages/Logs";
import Errors from "./pages/Errors";
import SelfHosting from "./pages/SelfHosting";
import Deploying from "./pages/Deploying";
import Configuration from "./pages/Configuration";

const SITE = "http://localhost:5274";
const CONSOLE = "http://localhost:5273";

const NAV = [
  { group: "Getting started", items: [
    { to: "/", label: "Introduction", el: <Introduction /> },
    { to: "/quickstart", label: "Quickstart", el: <Quickstart /> },
    { to: "/authentication", label: "Authentication", el: <Authentication /> },
  ]},
  { group: "Core resources", items: [
    { to: "/connections", label: "Connections", el: <Connections /> },
    { to: "/agents", label: "Agents", el: <Agents /> },
    { to: "/tools", label: "Tools", el: <Tools /> },
    { to: "/calls", label: "Calls", el: <Calls /> },
  ]},
  { group: "Events & logs", items: [
    { to: "/webhooks", label: "Webhooks", el: <Webhooks /> },
    { to: "/inbound", label: "Inbound calls", el: <Inbound /> },
    { to: "/logs", label: "Logs & analytics", el: <Logs /> },
  ]},
  { group: "Self-hosting", items: [
    { to: "/self-hosting", label: "Overview", el: <SelfHosting /> },
    { to: "/deploying", label: "Deploying", el: <Deploying /> },
    { to: "/configuration", label: "Configuration", el: <Configuration /> },
  ]},
  { group: "Reference", items: [
    { to: "/errors", label: "Errors & limits", el: <Errors /> },
  ]},
];

const FLAT = NAV.flatMap((g) => g.items);

const Wave = ({ s = 17 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#C45A3B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12h3l2-7 4 14 3-11 2 6 2-2h4" /></svg>
);

export default function App() {
  const loc = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [loc.pathname]);
  return (
    <>
      <header className="topbar">
        <a href={SITE} className="brand"><span className="brand-mark"><Wave /></span>Offhook<span className="brand-tag">docs</span></a>
        <nav className="top-links">
          <a href={`${SITE}/#features`}>Product</a>
          <a href={CONSOLE}>Console</a>
          <a href={CONSOLE} style={{ color: "var(--clay-deep)", fontWeight: 600 }}>Get a key →</a>
        </nav>
      </header>
      <div className="layout">
        <aside className="sidebar">
          {NAV.map((g) => (
            <div className="nav-group" key={g.group}>
              <h4>{g.group}</h4>
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === "/"} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </aside>
        <main className="content">
          <Routes>
            {FLAT.map((it) => <Route key={it.to} path={it.to} element={<><div>{it.el}</div><Pager path={it.to} /></>} />)}
          </Routes>
        </main>
      </div>
    </>
  );
}

function Pager({ path }: { path: string }) {
  const idx = FLAT.findIndex((i) => i.to === path);
  const prev = idx > 0 ? FLAT[idx - 1] : null;
  const next = idx < FLAT.length - 1 ? FLAT[idx + 1] : null;
  return (
    <div className="pager">
      {prev ? <Link to={prev.to}><div className="dir">← Previous</div><div className="ttl">{prev.label}</div></Link> : <span style={{ flex: 1 }} />}
      {next ? <Link to={next.to} className="next"><div className="dir">Next →</div><div className="ttl">{next.label}</div></Link> : <span style={{ flex: 1 }} />}
    </div>
  );
}
