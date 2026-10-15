const CONSOLE_URL = "http://localhost:5273";
const DOCS_URL = "http://localhost:5275";

/* tiny inline icons */
const I = ({ d, s = 20 }: { d: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);
const ICONS = {
  wave: "M2 12h3l2-7 4 14 3-11 2 6 2-2h4",
  key: "M14 7a3 3 0 1 1-3 3M11 10l-7 7v3h3v-2h2v-2h2l1-1",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z",
  bolt: "M13 3 4 14h6l-1 7 9-11h-6l1-7Z",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  inbox: "M4 13l2.5 4h11L20 13M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7M4 13h4l1.5 2h5l1.5-2h4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.5 3.5 6 3.5 9S14.5 18.5 12 21M12 3C9.5 5.5 8.5 9 8.5 12s1 6.5 3.5 9",
  check: "M5 12l5 5 9-11",
};

export default function App() {
  return (
    <>
      <Nav />
      <Hero />
      <Providers />
      <HowItWorks />
      <Features />
      <Observability />
      <CTA />
      <Footer />
    </>
  );
}

function Nav() {
  return (
    <nav className="nav">
      <div className="wrap nav-inner">
        <a href="#" className="brand"><span className="brand-mark"><span style={{ color: "#C45A3B" }}><I d={ICONS.wave} s={17} /></span></span>Offhook</a>
        <div className="nav-links">
          <a href="#how" className="hide-sm">How it works</a>
          <a href="#features" className="hide-sm">Features</a>
          <a href={DOCS_URL}>Docs</a>
          <a href={CONSOLE_URL} className="btn btn-ghost" style={{ padding: "8px 16px" }}>Open console</a>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <header className="hero">
      <div className="wrap hero-grid">
        <div>
          <span className="eyebrow reveal">◆ Voice API · bring your own models</span>
          <h1 className="reveal d1">Phone calls,<br /><em>programmable.</em></h1>
          <p className="lede reveal d2">
            One API to place and receive AI voice calls — wired to your own
            speech, language, and telephony providers. Reliable delivery,
            signed webhooks, and a complete log of every call.
          </p>
          <div className="hero-cta reveal d3">
            <a href={CONSOLE_URL} className="btn btn-primary btn-lg">Start building →</a>
            <a href={DOCS_URL} className="btn btn-ghost btn-lg">Read the docs</a>
          </div>
          <div className="hero-note reveal d4">no minutes markup · your keys, encrypted · self-hostable</div>
        </div>
        <div className="reveal d3">
          <CodeWindow />
        </div>
      </div>
    </header>
  );
}

function CodeWindow() {
  return (
    <div className="window">
      <div className="window-bar">
        <span className="dot" style={{ background: "#E05B49" }} />
        <span className="dot" style={{ background: "#E8B04B" }} />
        <span className="dot" style={{ background: "#52A06E" }} />
        <span className="label">POST /v1/calls</span>
      </div>
      <div className="window-body">
        <div><span className="c-com"># place an outbound call</span></div>
        <div><span className="c-cmd">curl</span> -X POST api.offhook.dev/v1/calls \</div>
        <div>{"  "}-H <span className="c-str">"Authorization: Bearer vk_live_…"</span> \</div>
        <div>{"  "}-d <span className="c-punc">{"'{"}</span></div>
        <div>{"    "}<span className="c-key">"agent_id"</span><span className="c-punc">:</span> <span className="c-str">"agt_8f2c"</span><span className="c-punc">,</span></div>
        <div>{"    "}<span className="c-key">"to_number"</span><span className="c-punc">:</span> <span className="c-str">"+1 415 555 0123"</span><span className="c-punc">,</span></div>
        <div>{"    "}<span className="c-key">"context"</span><span className="c-punc">:</span> <span className="c-punc">{"{"}</span> <span className="c-key">"name"</span><span className="c-punc">:</span> <span className="c-str">"Priya"</span> <span className="c-punc">{"}"}</span></div>
        <div>{"  "}<span className="c-punc">{"}'"}</span></div>
        <div style={{ height: 14 }} />
        <div className="evt"><span className="tdot" style={{ background: "#7E94B5" }} /><span className="et">call.queued</span><span className="ets">0.0s</span></div>
        <div className="evt"><span className="tdot" style={{ background: "#C9952F" }} /><span className="et">call.dialing</span><span className="ets">0.3s</span></div>
        <div className="evt"><span className="tdot" style={{ background: "#C9952F" }} /><span className="et">call.in_progress</span><span className="ets">4.1s</span></div>
        <div className="evt"><span className="tdot" style={{ background: "#5AA37E" }} /><span className="et">call.completed</span><span className="ets">38s</span></div>
      </div>
    </div>
  );
}

function Providers() {
  return (
    <section style={{ padding: "20px 0 10px" }}>
      <div className="wrap center">
        <p className="mono" style={{ color: "var(--ink-3)", fontSize: 13, letterSpacing: ".08em" }}>WORKS WITH THE PROVIDERS YOU ALREADY USE</p>
        <div className="providers">
          <span>Deepgram</span><span>Cartesia</span><span>Groq</span><span>OpenAI</span><span>Gemini</span><span>Plivo</span>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how">
      <div className="wrap">
        <div className="reveal">
          <div className="sec-eyebrow">How it works</div>
          <h2 className="sec-title">Live in three steps.</h2>
          <p className="sec-sub">No bundled black box. You connect your own providers, describe an agent, and call the API.</p>
        </div>
        <div className="steps">
          <div className="step reveal d1">
            <div className="step-n">01</div>
            <h3>Connect providers</h3>
            <p>Add your STT, TTS, LLM and telephony keys. They're encrypted at rest and never leave your account.</p>
            <pre>POST /v1/connections
{`{ "provider_name": "groq",
  "secrets": { "api_key": "…" } }`}</pre>
          </div>
          <div className="step reveal d2">
            <div className="step-n">02</div>
            <h3>Define an agent</h3>
            <p>Give it instructions, a voice, and the connections it runs on. Reuse it across every call.</p>
            <pre>POST /v1/agents
{`{ "name": "Alex",
  "instructions": "Confirm the…" }`}</pre>
          </div>
          <div className="step reveal d3">
            <div className="step-n">03</div>
            <h3>Place the call</h3>
            <p>Hand over a number and per-call context. We dial, run the conversation, and stream you events.</p>
            <pre>POST /v1/calls
{`{ "agent_id": "agt_8f2c",
  "to_number": "+1415…" }`}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  { i: ICONS.key, t: "Bring your own keys", d: "Use your existing provider contracts. No minutes markup — you pay for orchestration, not a reseller's margin." },
  { i: ICONS.shield, t: "Encrypted by design", d: "Per-tenant envelope encryption (AES-GCM), argon2-hashed API keys, SSRF guards, and log redaction throughout." },
  { i: ICONS.bolt, t: "Reliable delivery", d: "An async dial queue with retries, exponential backoff, and circuit breakers. Built to survive a flaky carrier." },
  { i: ICONS.list, t: "Signed webhooks", d: "HMAC-signed callbacks for every status transition, with automatic retries. Verify and trust." },
  { i: ICONS.inbox, t: "Inbound + outbound", d: "Place calls or route a number straight to an agent. Same pipeline, same observability, both directions." },
  { i: ICONS.globe, t: "Any provider, any model", d: "Deepgram, Cartesia, Groq, OpenAI, Gemini, Plivo — swap a provider with a connection, not a rewrite." },
];

function Features() {
  return (
    <section id="features">
      <div className="wrap">
        <div className="reveal">
          <div className="sec-eyebrow">Platform</div>
          <h2 className="sec-title">Infrastructure, not a demo.</h2>
          <p className="sec-sub">The unglamorous things that decide whether voice agents survive contact with production.</p>
        </div>
        <div className="features">
          {FEATURES.map((f, i) => (
            <div className={`feature reveal d${(i % 3) + 1}`} key={f.t}>
              <div className="ico"><I d={f.i} s={20} /></div>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Observability() {
  const rows = [
    { c: "#7E94B5", t: "call.queued", s: "0.00s" },
    { c: "#C9952F", t: "call.dialing", s: "0.31s" },
    { c: "#C9952F", t: "call.in_progress", s: "4.12s" },
    { c: "#9C988C", t: "carrier.hangup", s: "37.9s" },
    { c: "#5AA37E", t: "call.completed", s: "38.0s" },
  ];
  return (
    <section id="observability">
      <div className="wrap split">
        <div className="reveal">
          <div className="sec-eyebrow">Observability</div>
          <h2 className="sec-title">SendGrid-grade logs for phone calls.</h2>
          <p className="sec-sub" style={{ maxWidth: 460 }}>
            Every call leaves a complete, queryable trail. Know exactly what happened, why it failed, and what was said.
          </p>
          <ul className="check-list">
            {["Raw event timeline for every call", "Full transcripts as call content", "Stable error codes — busy, no-answer, carrier", "Activity feed + failure-rate analytics"].map((t) => (
              <li key={t}><span className="ci"><I d={ICONS.check} s={18} /></span>{t}</li>
            ))}
          </ul>
        </div>
        <div className="ledger reveal d2">
          <div className="ledger-head"><span>call_8f2c… · event log</span><span>5 events</span></div>
          {rows.map((r) => (
            <div className="ledger-row" key={r.t}>
              <span className="rn" style={{ background: r.c }} />
              <span className="rt" style={{ color: r.c }}>{r.t}</span>
              <span className="rs">{r.s}</span>
            </div>
          ))}
          <div style={{ padding: "14px 18px", borderTop: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>
            <span style={{ color: "var(--clay-deep)" }}>agent</span> · "Great, you're all set for Tuesday at 3."
          </div>
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section>
      <div className="wrap">
        <div className="cta reveal">
          <h2>Ship a voice agent this afternoon.</h2>
          <p>Connect your providers, define an agent, and make your first call in minutes.</p>
          <div className="hero-cta">
            <a href={CONSOLE_URL} className="btn btn-primary btn-lg">Open the console →</a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap foot-inner">
        <div className="brand" style={{ fontSize: 18 }}>
          <span className="brand-mark" style={{ width: 26, height: 26 }}><span style={{ color: "#C45A3B" }}><I d={ICONS.wave} s={15} /></span></span>Offhook
        </div>
        <div>© {new Date().getFullYear()} Offhook · voice infrastructure for developers</div>
      </div>
    </footer>
  );
}
