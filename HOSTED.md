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
