import { useEffect } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { SignedIn, SignedOut, SignIn, UserButton, useAuth, useUser } from "@clerk/clerk-react";
import { setTokenGetter } from "./api";
import { Icon } from "./ui";
import Overview from "./pages/Overview";
import Calls from "./pages/Calls";
import CallDetail from "./pages/CallDetail";
import ApiKeys from "./pages/ApiKeys";
import Connections from "./pages/Connections";
import Agents from "./pages/Agents";
import Tools from "./pages/Tools";
import Webhooks from "./pages/Webhooks";
import Numbers from "./pages/Numbers";

const DOCS_URL = "http://localhost:5275";

const NAV = [
  { to: "/", icon: "overview", label: "Overview", end: true },
  { to: "/calls", icon: "calls", label: "Calls" },
  { sec: "Configure" },
  { to: "/agents", icon: "agents", label: "Agents" },
  { to: "/tools", icon: "tools", label: "Tools" },
  { to: "/connections", icon: "connections", label: "Connections" },
  { to: "/numbers", icon: "numbers", label: "Numbers" },
  { sec: "Developers" },
  { to: "/keys", icon: "keys", label: "API Keys" },
  { to: "/webhooks", icon: "webhooks", label: "Webhooks" },
] as const;

export default function App() {
  return (
    <>
      <SignedOut>
        <SignInScreen />
      </SignedOut>
      <SignedIn>
        <TokenBridge />
        <Shell />
      </SignedIn>
    </>
  );
}

/* Feed Clerk's session token to the API client once signed in. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(async () => {
      try { return await getToken(); } catch { return null; }
    });
  }, [getToken]);
  return null;
}

function Shell() {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/numbers" element={<Numbers />} />
          <Route path="/keys" element={<ApiKeys />} />
          <Route path="/webhooks" element={<Webhooks />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Sidebar() {
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress || user?.username || "";
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Icon name="wave" size={17} /></div>
        <span className="brand-name">Offhook</span>
      </div>
      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((n, i) =>
          "sec" in n ? (
            <div className="nav-label" key={i}>{n.sec}</div>
          ) : (
            <NavLink key={n.to} to={n.to} end={"end" in n ? n.end : false}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <Icon name={n.icon} size={17} className="nav-ico" />
              {n.label}
            </NavLink>
          )
        )}
      </nav>
      <div className="sidebar-foot">
        <a className="nav-item" href={DOCS_URL} target="_blank" rel="noreferrer" style={{ color: "var(--ink-2)" }}>
          <Icon name="doc" size={17} className="nav-ico" />
          API docs
        </a>
        <div className="row" style={{ padding: "10px 10px 2px", gap: 9 }}>
          <UserButton afterSignOutUrl="/" />
          <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
        </div>
      </div>
    </aside>
  );
}

function SignInScreen() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 1 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div className="row" style={{ marginBottom: 22, justifyContent: "center" }}>
          <div className="brand-mark"><Icon name="wave" size={18} /></div>
          <span className="brand-name">Offhook</span>
        </div>
        <div style={{ display: "grid", placeItems: "center" }}>
          <SignIn routing="virtual" appearance={{
            variables: {
              colorPrimary: "#B5512E",
              colorBackground: "#FFFFFF",
              colorText: "#1B1A17",
              fontFamily: '"Hanken Grotesk", sans-serif',
              borderRadius: "9px",
            },
          }} />
        </div>
      </div>
    </div>
  );
}
