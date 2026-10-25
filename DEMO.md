# Offhook: use-case site and live demo

Design for repositioning offhook.welldun.ai around use cases, with a live in-browser demo and a hosted-version waitlist.

## Goals

1. A business visitor understands in one screen what Offhook does for them: an AI agent that makes the calls their team makes every day.
2. They can try it straight away: pick a use case (or write their own) and talk to the agent in the browser, playing the person being called.
3. Afterwards they see how it went: the transcript, what the agent recorded, and how fast it replied each turn.
4. Then they can join the waitlist for the hosted version.
5. Developers still find the open-source, self-hosted story and the docs.

## Non-goals (for now)

- Real phone calls from the website. The demo is browser-only: visitors only ever talk to themselves, so a custom script can't be used on anyone else, and no consent rules for automated calls apply.
- A hosted product, accounts or billing. The waitlist is the only next step.
- Payment-reminder or collections use cases.

## Use cases at launch

Each use case is a fixed agent configuration plus a short brief for the visitor.

| Use case | The agent | The visitor plays | The agent records |
| --- | --- | --- | --- |
| Recruiter screening | Sam, a recruiter at Northwind, following up an application for a backend engineer role | The candidate | `interested`, `notice_period`, `salary_expectation`, `interview_slot` |
| Appointment confirmation | Alex at Acme Clinic, confirming Tuesday 3 PM with Dr. Rao | The patient | `confirmed`, `new_time`, `notes` |
| Lead qualification | Riya at Brightdesk, calling back someone who requested a demo | The lead | `need`, `team_size`, `timeline`, `demo_booked` |

The company names are fictional and shown as such.

### Writing your own case

A form with: agent name, company, what the agent should achieve (instructions), its opening line, facts it knows (key/value context), and up to five fields to record. Limits: instructions up to 1,500 characters, opening line up to 200, at most ten context facts and five fields. Custom agents get only the built-in `record_result` and `end_call` tools; no HTTP tools.

## The visitor's flow

1. **Choose** a use case card, or "Write your own".
2. **Brief:** who you are in this call and what the agent is trying to do ("You're the candidate. You're interested but have a 60-day notice period.").
3. **Start call:** Turnstile check, then the browser asks for the microphone and shows "Connecting…". A two-minute countdown runs; the agent speaks first.
4. **Live view:** the transcript appears as you talk, and the call status moves from connecting to in progress to completed.
5. **Results:** the full transcript, the recorded fields as a small table, the agent's summary, and its response time on each turn.
6. **Next:** "Join the waitlist for hosted Offhook" (email, company, which use case) and "Run it yourself" (docs).

## Limits

| Limit | Value | Where it's enforced |
| --- | --- | --- |
| Calls per visitor per day | 3 | Server: keyed on a salted, daily-rotated hash of the IP plus a first-party cookie ID; whichever is used up first counts |
| Call length | 2 minutes | Server: at 1:45 the agent is told to wrap up; at 2:00 the call ends |
| Silence | 20 seconds with nobody talking ends the call | Server |
| Bot check | Cloudflare Turnstile before every call and waitlist signup | Server verifies the token |
| Concurrent calls, site-wide | 5 (configurable) | Server; visitors over it see "all lines busy, try again in a minute" |
| Daily minutes, site-wide | Configurable backstop, default 300 | Server; when reached, the demo shows that it's paused until tomorrow |

Each limit has a clear message in the UI, saying what happened and when the visitor can try again.

## Privacy

- The page says, before the microphone prompt, that audio is processed by Deepgram, Cartesia and Groq to run the call.
- Demo calls are **not recorded**. Transcripts and results are kept for 24 hours so the results page works, then deleted.
- IP addresses are only stored as salted hashes that rotate daily.
- Waitlist entries keep email, company and use case, and are used only to contact people about hosted Offhook.

## Architecture (Cloudflare free plan + your machine)

Everything public runs on Cloudflare's free plan. The voice server, which runs Offhook's real Python pipeline, runs on your own computer and is reachable only through a Cloudflare Tunnel. Nothing on your machine is opened to the internet directly.

```
browser (offhook.welldun.ai, static)
   │  1. POST /sessions  {use case or custom, Turnstile token}
   ▼
Worker  demo.offhook.welldun.ai  (TypeScript, free plan)
   ├─ verifies Turnstile
   ├─ checks the voice server is up (cached health check)
   ├─ asks the Gate (one Durable Object) for a slot: per-visitor quota,
   │  site-wide concurrency, daily minute cap, all checked atomically
   └─ stores the session in D1, returns {session_id, ticket, voice_url}
   │
   │  2. browser opens the audio WebSocket to voice_url with the ticket
   ▼
Cloudflare Tunnel  voice.offhook.welldun.ai ──▶ your machine: voice server (Docker)
                                                 ├─ claims the ticket from the Worker (single use)
                                                 │  and gets the session's agent config
                                                 ├─ runs the Pipecat pipeline (reused from Offhook)
                                                 ├─ 2-minute and 20-second-silence cutoffs
                                                 └─ calls Deepgram, Cartesia, Groq
   3. at hang-up the voice server posts transcript, outcome and per-turn latency
      to the Worker (signed); the Worker stores them in D1 and frees the slot
   4. browser fetches GET /sessions/{id} for the results page
```

### The pieces

| Piece | What it is | Where |
| --- | --- | --- |
| **Worker** | Routes `/sessions`, `/sessions/{id}`, `/waitlist` and the internal `/claim` and `/results`; checks Turnstile, CORS and voice-server health | Cloudflare, free |
| **Gate** (Durable Object, one instance) | Hands out and frees call slots; enforces the per-visitor daily quota, site-wide concurrency and the daily minute cap. One object, so counts can't race | Cloudflare, free (SQLite storage) |
| **D1** | `demo_sessions` (config, visitor hash, status, transcript, outcome, latency, expires_at) and `waitlist_entries` | Cloudflare, free |
| **Tunnel** | `cloudflared` on your machine, publishing only the voice server's port as `voice.offhook.welldun.ai` | Cloudflare, free |
| **Voice server** | A slim Python entrypoint, `app/demo/server.py`, in Docker: one health route and one WebSocket route. No database, no tenant API | Your machine |

A scheduled Worker (hourly cron) deletes demo sessions older than 24 hours.

### Audio over WebSocket

The browser captures the microphone with an AudioWorklet and sends 16 kHz 16-bit PCM over the WebSocket; the agent's audio comes back the same way. That is about 256 kbit/s each way per call, so five calls at once need roughly 1.3 Mbit/s of upload from your connection. Using one WebSocket (instead of WebRTC) means the tunnel only has to carry ordinary HTTPS traffic, and no TURN server is needed.

### Tickets

`POST /sessions` returns a ticket: the session ID, an expiry one minute out, and an HMAC signature. When the browser connects, the voice server checks the signature and expiry, then calls the Worker's `/claim` with the session ID. The Gate marks the session as started and returns its agent config, exactly once. A replayed or late ticket is refused. The voice server never trusts config sent by the browser.

### When your machine is off

The Worker checks `voice.offhook.welldun.ai/healthz` with a two-second timeout, and caches the answer for 30 seconds. If the voice server is down, `POST /sessions` returns "offline". The site then shows "The live demo is offline right now" with the sample transcripts and the waitlist, so the page still works. Sessions that never connect release their slot after a minute.

To keep it up while you're away:
- Run the voice server and `cloudflared` with Docker's `restart: unless-stopped`, so they come back after a reboot.
- Stop the Mac from sleeping (`caffeinate -s`, or Energy settings) while the demo should be available.

### Endpoints (`demo.offhook.welldun.ai`)

| Endpoint | Purpose |
| --- | --- |
| `GET /use-cases` | The launch use cases, with briefs and fields |
| `GET /status` | Whether the live demo is online right now |
| `POST /sessions` | `{use_case}` or `{custom: {…}}` plus `turnstile_token`. Returns `{session_id, ticket, voice_url}`, a limit error, or "offline" |
| `GET /sessions/{id}` | Status, transcript, outcome, summary, per-turn latency |
| `POST /waitlist` | `{email, company?, use_case?, turnstile_token}` |
| `POST /internal/claim`, `POST /internal/results` | Voice server to Worker only, HMAC-signed |

CORS allows only `https://offhook.welldun.ai` (and localhost in dev). The voice server accepts WebSocket connections only with a valid ticket.

### Configuration

- **Worker vars and secrets:** `ALLOWED_ORIGINS`, `VOICE_URL`, `DAILY_CALLS_PER_VISITOR=3`, `MAX_CALL_SECONDS=120`, `MAX_CONCURRENT=5`, `DAILY_MINUTES_CAP=300`, `TURNSTILE_SECRET_KEY`, `DEMO_HMAC_SECRET`, `VISITOR_HASH_SALT`.
- **Voice server (`.env` on your machine):** `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `GROQ_API_KEY`, `DEMO_HMAC_SECRET`, `WORKER_URL`.
- **Tunnel:** a tunnel token from the Cloudflare dashboard, used by the `cloudflared` container.

### Moving off your machine later

The voice server is a plain Docker image with no local state, so it can move to Cloudflare Containers (Workers Paid plan) or any other host by changing `VOICE_URL`. Nothing else changes.

## Costs

The demo spends your provider credit (speech-to-text, text-to-speech and the model) for every minute someone talks. At 3 calls of 2 minutes, one visitor can use at most 6 minutes a day, and the site-wide daily cap bounds the worst case. Hosting is free: the Worker, Durable Objects, D1, Turnstile and the Tunnel are on Cloudflare's free plan, whose allowances are well above this volume, and the voice server uses your own machine and connection.

## Milestones

Each one ends with a review before the next starts.

1. **Site repositioning (static).** New hero and positioning, the three use-case cards with sample transcripts and recorded fields, the developer section moved down, and a "Try it" button that is disabled until M3.
2. **Demo backend.** The voice server (`app/demo/server.py`: WebSocket audio, tickets, cutoffs, results callback, Docker image) and the Worker (Gate, D1, Turnstile, limits, health check, waitlist, expiry), with tests. Runs locally with `wrangler dev`.
3. **Demo UI.** The brief, the live call with countdown and transcript, the results view, the custom-case form and every limit message, against the local backend.
4. **Deploy.** The Worker, Gate and D1 on your Cloudflare account under `demo.offhook.welldun.ai`; the tunnel as `voice.offhook.welldun.ai`; the voice server and `cloudflared` running in Docker on your machine; Turnstile set up and CORS locked to the site. Then the "Try it" buttons go live.
5. **Waitlist.** The signup form on the site, plus a simple way for you to export entries.

## Open questions

- **Waitlist access:** the simplest is reading entries from D1 (`wrangler d1 execute` or the Cloudflare dashboard). Do you want an email on each signup too?
- **Hosted name:** is the hosted version still called Offhook, or something else?
