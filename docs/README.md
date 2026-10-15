# Offhook Docs

The developer documentation site for the Offhook voice API — a Vite + React + TS
single-page app with client-side routing. Static; no backend dependency.

```bash
npm install
npm run dev        # http://localhost:5275
npm run build      # -> dist/  (serve with SPA fallback to index.html)
```

Pages: Introduction, Quickstart, Authentication, Connections, Agents, Calls,
Webhooks, Inbound calls, Logs & analytics, Self-hosting (Overview, Deploying,
Configuration), Errors & limits.

The host links (console :5273, site :5274) are constants at the top of
`src/App.tsx` / page files — point them at your real domains for production.
