# Offhook Console (dashboard)

A Vite + React + TypeScript dashboard for the Offhook voice API. Users **sign in
with Clerk**; their first login provisions a workspace. View calls, raw event
logs, transcripts, and analytics, and manage agents, connections, webhooks,
numbers, and API keys.

## Setup

```bash
npm install
cp .env.example .env     # set VITE_CLERK_PUBLISHABLE_KEY (and VITE_API_URL)
npm run dev              # http://localhost:5273
```

You need a [Clerk](https://clerk.com) application:
- Frontend: put its **publishable key** in `VITE_CLERK_PUBLISHABLE_KEY`.
- Backend: set **`CLERK_ISSUER`** (e.g. `https://your-app.clerk.accounts.dev`)
  so the API can verify session tokens. The backend's `CORS_ORIGINS` must
  include this origin (port 5273 is already allowed).

Without a publishable key the app shows a "configure Clerk" notice.

## How auth works
- The dashboard sends the signed-in user's **Clerk session JWT** as a bearer
  token. The backend verifies it (JWKS), maps the Clerk user to a tenant, and
  scopes all data to that tenant.
- **API keys** (created on the API Keys page, with optional expiry) are for your
  own servers — bearer-auth the API directly. You don't need one to use the
  dashboard.

## Pages
Overview · Calls (→ event timeline + transcript) · Agents · Connections ·
Numbers · API Keys · Webhooks.
