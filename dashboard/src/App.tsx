import { useEffect, useState } from "react";
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

const DOCS_URL = "https://offhook.welldun.ai/docs/";
const SITE_URL = "https://offhook.welldun.ai/";

const NAV = [
  { to: "/", icon: "overview", label: "Overview", end: true },
  { to: "/calls", icon: "calls", label: "Calls" },
  { sec: "Configure" },
  { to: "/agents", icon: "agents", label: "Agents" },
  { to: "/tools", icon: "tools", label: "Tools" },
  { to: "/connections", icon: "connections", label: "Connections" },
  { to: "/numbers", icon: "numbers", label: "Numbers" },
  { sec: "Developers" },
  { to: "/keys", icon: "keys", label: "API keys" },
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
        <OffhookLogo />
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
        <a className="nav-item" href={DOCS_URL} target="_blank" rel="noreferrer">
          <Icon name="doc" size={17} className="nav-ico" />
          Docs
        </a>
        <ThemeSwitch />
        <div className="row" style={{ padding: "10px 10px 2px", gap: 9 }}>
          <UserButton afterSignOutUrl="/" />
          <span style={{ fontSize: 13, color: "var(--ink-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
        </div>
      </div>
    </aside>
  );
}

function SignInScreen() {
  const appearance = useClerkAppearance();
  return (
    <div className="signin">
      <div className="signin-inner">
        <OffhookLogo large />
        <span className="signin-by">by welldun<span className="signin-by-dot">.</span></span>
        <SignIn routing="virtual" appearance={appearance} />
        <p className="muted" style={{ margin: 0, maxWidth: 360, fontSize: 14 }}>
          Offhook is invite-only for now. Not invited yet?{" "}
          <a href={SITE_URL} style={{ color: "var(--link)", textDecoration: "underline", textUnderlineOffset: 3 }}>
            Try the live demo and join the list
          </a>.
        </p>
      </div>
    </div>
  );
}

/** The Offhook mark and wordmark, the same as on offhook.welldun.ai. */
function OffhookLogo({ large = false }: { large?: boolean }) {
  return (
    <span className={`oh-logo${large ? " oh-logo--lg" : ""}`} aria-label="Offhook">
      <svg className="oh-mark" viewBox="0 0 64 64" aria-hidden="true">
        <path className="oh-mark-bubble" d="M14 8h36a10 10 0 0 1 10 10v22a10 10 0 0 1-10 10H30l-10 9v-9h-6A10 10 0 0 1 4 40V18A10 10 0 0 1 14 8z" />
        <rect x="21" y="22" width="5" height="14" rx="2.5" fill="#fff" />
        <rect x="29.5" y="16" width="5" height="26" rx="2.5" fill="#fff" />
        <rect x="38" y="20" width="5" height="18" rx="2.5" fill="#fff" />
      </svg>
      <span className="oh-word" aria-hidden="true">offhook</span>
    </span>
  );
}

type Theme = "system" | "light" | "dark";

/** Reads the current theme choice (see the script in index.html). */
function currentTheme(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : "system";
}

/**
 * Applies and remembers a theme choice: on the page, in localStorage, and in the
 * wd-theme cookie on .welldun.ai so the site and the blog follow it too.
 * Args: t — the choice.
 */
function applyTheme(t: Theme) {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("wd-theme", t); } catch { /* private mode */ }
  if (location.hostname.endsWith("welldun.ai")) {
    document.cookie = `wd-theme=${t}; Domain=welldun.ai; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
  }
  window.dispatchEvent(new Event("wd-theme"));
}

/**
 * System / Light / Dark, shared with offhook.welldun.ai and the blog through the
 * wd-theme cookie on .welldun.ai (localStorage elsewhere, e.g. localhost).
 */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const choose = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <div className="theme">
      <span className="theme-label">Theme</span>
      <div className="pill-toggle" role="radiogroup" aria-label="Theme">
        {(["system", "light", "dark"] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => choose(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Clerk's sign-in box in the Offhook colours, re-read when the theme changes. */
function useClerkAppearance() {
  const read = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return {
      variables: {
        colorPrimary: v("--signal-strong"),
        colorBackground: v("--surface-raised"),
        colorText: v("--ink"),
        colorTextSecondary: v("--ink-muted"),
        colorInputBackground: v("--surface-raised"),
        colorInputText: v("--ink"),
        colorTextOnPrimaryBackground: v("--on-signal"),
        colorNeutral: v("--ink"),
        fontFamily: '"Figtree", system-ui, sans-serif',
        borderRadius: "12px",
      },
      elements: {
        socialButtonsBlockButton: { backgroundColor: v("--surface-sunken"), color: v("--ink"), borderColor: v("--line-strong") },
        socialButtonsBlockButtonText: { color: v("--ink") },
      },
    };
  };
  const [appearance, setAppearance] = useState(read);
  useEffect(() => {
    const update = () => setAppearance(read());
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    window.addEventListener("wd-theme", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("wd-theme", update);
    };
  }, []);
  return appearance;
}
