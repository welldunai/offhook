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
3. **Start call:** Turnstile check, then the browser asks for the microphone and shows "Connecting…" while a line warms up. A two-minute countdown runs; the agent speaks first.
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

## Architecture (all on Cloudflare)

```
browser (offhook.welldun.ai, static)
   │  1. POST /sessions  {use case or custom, Turnstile token}
   ▼
Worker  demo.offhook.welldun.ai  (TypeScript)
   ├─ verifies Turnstile
   ├─ asks the Gate (one Durable Object) for a slot: per-visitor quota,
   │  site-wide concurrency, daily minute cap, all checked atomically
   ├─ writes the session to D1 and returns {session_id, ws_url}
   │
   │  2. browser opens a WebSocket to ws_url (mic audio in, agent audio out)
   ▼
Line (Durable Object) ──proxies the WebSocket──▶ Container: the Python voice server
                                                   ├─ Pipecat pipeline, reused from Offhook
                                                   ├─ 2-minute and 20-second-silence cutoffs
                                                   └─ calls Deepgram, Cartesia, Groq (HTTPS/WSS on 443)
   3. at hang-up the container sends transcript, outcome and per-turn latency
      back to the Worker (signed); the Worker stores them in D1 and frees the slot
   4. browser fetches GET /sessions/{id} for the results page
```

### Why WebSocket audio, not WebRTC

Cloudflare Containers accept traffic only through a Worker (HTTP and WebSockets) and can make outbound connections only on ports 80 and 443. WebRTC wants direct UDP, which would force every call through a TURN relay. Streaming audio over the WebSocket instead keeps the whole path on one connection: the browser captures the microphone with an AudioWorklet, sends 16 kHz PCM frames, and plays the agent's audio back the same way. It is slightly less resilient than WebRTC on bad networks, which is acceptable for a two-minute demo. No TURN server is needed.

### The pieces

| Piece | What it is | State |
| --- | --- | --- |
| **Worker** | Routes `/sessions`, `/sessions/{id}`, `/sessions/{id}/ws`, `/waitlist` and `/internal/results`; checks Turnstile and CORS | None |
| **Gate** (Durable Object, one instance) | Hands out and frees call slots; enforces the per-visitor daily quota, site-wide concurrency and the daily minute cap. One object, so the counts can't race | Its own storage |
| **Line** (Durable Object + Container) | Starts or reuses a container and proxies the call's WebSocket to it. A small fixed pool of lines (e.g. 2, each taking up to 3 calls) keeps containers warm instead of starting one per call | None |
| **Voice server** (Container) | A slim Python entrypoint, `app/demo/server.py`: one WebSocket route, builds the agent from the session config, runs the existing pipeline. No database, no tenant API | None |
| **D1** | `demo_sessions` (config, visitor hash, status, transcript, outcome, latency, expires_at) and `waitlist_entries` | Durable |

A scheduled Worker (cron, hourly) deletes demo sessions older than 24 hours and resets nothing else; quotas reset by date.

### Endpoints (`demo.offhook.welldun.ai`)

| Endpoint | Purpose |
| --- | --- |
| `GET /use-cases` | The launch use cases, with briefs and fields |
| `POST /sessions` | `{use_case}` or `{custom: {…}}` plus `turnstile_token`. Returns `{session_id, ws_url, expires_at}` or a limit error |
| `GET /sessions/{id}/ws` | The call's audio WebSocket. Accepted once per session, within a minute of creation |
| `GET /sessions/{id}` | Status, transcript, outcome, summary, per-turn latency |
| `POST /waitlist` | `{email, company?, use_case?, turnstile_token}` |
| `POST /internal/results` | Container to Worker only, HMAC-signed |

CORS allows only `https://offhook.welldun.ai` (and localhost in dev).

### Configuration

- **Worker vars and secrets:** `ALLOWED_ORIGINS`, `DAILY_CALLS_PER_VISITOR=3`, `MAX_CALL_SECONDS=120`, `MAX_CONCURRENT=5`, `DAILY_MINUTES_CAP=300`, `TURNSTILE_SECRET_KEY`, `RESULTS_HMAC_SECRET`, `VISITOR_HASH_SALT`.
- **Container secrets:** `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `GROQ_API_KEY`, `RESULTS_HMAC_SECRET`.
- **Container size:** `standard-1` (1/2 vCPU, 4 GiB) or larger; the right size is measured in M4 with real calls.

### Cold starts

A container that has been idle starts on the next call, which takes several seconds (booting plus loading Pipecat and the speech models). The UI shows "Connecting…" during this, the agent's first line is spoken only once the pipeline is ready, and lines stay warm for 10 minutes after the last call.

## Costs

The demo spends your provider credit (speech-to-text, text-to-speech and the model) for every minute someone talks. At 3 calls of 2 minutes, one visitor can use at most 6 minutes a day, and the site-wide daily cap bounds the worst case. On Cloudflare, Containers need the Workers Paid plan and bill for the time containers run; Workers, Durable Objects, D1 and Turnstile have free allowances well above this volume.

## Milestones

Each one ends with a review before the next starts.

1. **Site repositioning (static).** New hero and positioning, the three use-case cards with sample transcripts and recorded fields, the developer section moved down, and a "Try it" button that is disabled until M3.
2. **Demo backend.** The voice server (`app/demo/server.py`, WebSocket audio, cutoffs, results callback) and the Worker (Gate, Line, D1, Turnstile, limits, waitlist, expiry), with tests. Runs locally with `wrangler dev` and the container image.
3. **Demo UI.** The brief, the live call with countdown and transcript, the results view, the custom-case form and every limit message, against the local backend.
4. **Deploy.** The Worker, Durable Objects, D1 and container on your Cloudflare account under `demo.offhook.welldun.ai`, Turnstile set up, CORS locked to the site; size the container with real calls; then the "Try it" buttons go live.
5. **Waitlist.** The signup form on the site, plus a simple way for you to export entries.

## Open questions

- **Waitlist access:** the simplest is reading entries from D1 (`wrangler d1 execute` or the Cloudflare dashboard). Do you want an email on each signup too?
- **Hosted name:** is the hosted version still called Offhook, or something else?
