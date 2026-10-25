# Hosted Offhook

Design for letting approved people sign up and use Offhook themselves: sign in to
the dashboard, add their own provider keys, create agents, make calls, and read
transcripts. The open-source, self-hosted product stays exactly as it is.

## Decisions

- **Where it runs:** the API, its Postgres database and the call worker run in Docker
  on the maintainer's Mac, reachable only through the Cloudflare Tunnel (the same
  tunnel as the demo voice server). Free; down when the Mac sleeps. Moving to a
  paid host later is a change of where the containers run, nothing else.
- **Who can sign up:** invite only. Clerk's allowlist holds approved emails,
  starting with the waitlist. Everyone else sees "Offhook is invite-only for now"
  and a link to join the waitlist.
- **Costs:** every workspace brings its own carrier (Twilio, Plivo) and AI keys
  (Deepgram, Cartesia, Groq, …), so calls cost the maintainer nothing.

## Pieces

| Piece | Where | Address |
| --- | --- | --- |
| Dashboard (React, `dashboard/`) | Cloudflare Workers static assets, free | `app.offhook.welldun.ai` |
| API + call worker (`app/`) | Docker on the Mac, behind the tunnel | `api.offhook.welldun.ai` |
| Postgres | Docker on the Mac, never exposed | — |
| Sign-in | Clerk production instance, allowlist on | — |

Sign-in already provisions a personal workspace on first login
(`app/tenancy/users.py`); provider keys are envelope-encrypted with the master key
(`app/crypto`).

## Milestones

Each ends with a review.

1. **Restyle the dashboard** to the Offhook brand: welldun design tokens, Figtree,
   the voice-bubble logo, light and dark with the shared theme switch.
2. **Run the whole stack locally in Docker** (Postgres, API, worker) with production
   settings, and walk through the dashboard end to end: connections, an agent, a
   call, its transcript and tags.
3. **Deploy:** the API on the tunnel as `api.offhook.welldun.ai`, the dashboard on
   Cloudflare as `app.offhook.welldun.ai`, Clerk in production with the allowlist,
   CORS locked to the dashboard.
4. **The site:** "Sign in" in the header; the demo's waitlist leads to an invite.
5. **Running it:** nightly Postgres backups, the master key kept off the repo and
   backed up, keeping the Mac awake, and what users see when it's down.

## Running it (milestone 2)

```bash
cp .env.hosted.example .env.hosted      # then fill in: a DB password (twice), a new
                                        # MASTER_ENCRYPTION_KEY, CLERK_ISSUER
docker compose -f docker-compose.hosted.yml up -d --build
curl localhost:8100/healthz             # {"status":"ok"}
```

- Three containers in their own Compose project, `offhook-hosted`: `db` (Postgres 16,
  data in the `hosted_pgdata` volume), `api` (runs migrations, then serves on
  127.0.0.1:8100) and `worker` (dials queued calls, sends webhooks).
- The hosted database and master key are separate from any dev setup. Provider keys
  are stored only encrypted (checked: no raw key appears in a full dump).
- Local dashboard against it: `VITE_API_URL=http://localhost:8100` in `dashboard/.env`,
  then `npx vite --port 5173` in `dashboard/`.

## Deployed (milestone 3)

| Address | What | How it's served |
| --- | --- | --- |
| `https://app.offhook.welldun.ai` | Dashboard | Cloudflare Worker `offhook-dashboard` (static assets, SPA fallback); `cd dashboard && npm run build && npx wrangler deploy` |
| `https://api.offhook.welldun.ai` | API (and carrier callbacks) | Tunnel `offhook-voice` → `host.docker.internal:8100` on the Mac |
| `https://clerk.app.offhook.welldun.ai` | Sign-in | Clerk production instance "Offhook", allowlist on |

- The API accepts browser requests only from the dashboard (`CORS_ORIGINS`), and
  every request needs a Clerk session or an API key.
- `PUBLIC_BASE_URL=https://api.offhook.welldun.ai`, so Twilio and Plivo can reach the
  call webhooks through the tunnel.
- To let someone in: add their email to the Clerk allowlist (Clerk dashboard →
  Restrictions). Their first sign-in creates their workspace.
