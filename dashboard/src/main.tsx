import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ClerkProvider } from "@clerk/clerk-react";
import "./index.css";
import App from "./App";
import { ToastProvider } from "./ui";

const PUB_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function MissingClerk() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 1 }}>
      <div className="card" style={{ maxWidth: 460, padding: 30 }}>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 23 }}>Authentication isn't configured</h1>
        <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
          Set <code style={{ fontFamily: "var(--mono)" }}>VITE_CLERK_PUBLISHABLE_KEY</code> in
          <code style={{ fontFamily: "var(--mono)" }}> dashboard/.env</code> (from your Clerk
          dashboard), then restart the dev server. The backend also needs{" "}
          <code style={{ fontFamily: "var(--mono)" }}>CLERK_ISSUER</code>.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {PUB_KEY ? (
      <ClerkProvider publishableKey={PUB_KEY} afterSignOutUrl="/">
        <BrowserRouter>
          <ToastProvider>
            <App />
          </ToastProvider>
        </BrowserRouter>
      </ClerkProvider>
    ) : (
      <MissingClerk />
    )}
  </StrictMode>
);
