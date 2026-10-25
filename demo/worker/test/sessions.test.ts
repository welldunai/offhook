import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/config";
import { cleanup } from "../src/cleanup";
import { signRequest } from "../src/sign";
import { resetVoiceCache } from "../src/voice";
import { testEnv } from "./env";

let env: Env;
let db: DatabaseSync;
beforeEach(() => {
  ({ env, db } = testEnv());
  resetVoiceCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SITE = { origin: "https://offhook.welldun.ai", "content-type": "application/json" };
const visitor = (n: number) => ({ ...SITE, "cf-connecting-ip": `203.0.113.${n}`, cookie: `oh_vid=3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a${String(n).padStart(2, "0")}` });
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.test${path}`, init), env);
const start = (body: unknown, n = 1) => call("/sessions", { method: "POST", headers: visitor(n), body: JSON.stringify({ turnstile_token: "x", ...(body as object) }) });
const signed = async (path: string, body: unknown, secret = "secret") => {
  const text = JSON.stringify(body);
  return call(path, { method: "POST", headers: { "content-type": "application/json", ...(await signRequest(secret, text, Date.now())) }, body: text });
};

/** Stubs fetch: Turnstile passes; the voice server's health check answers `voiceUp`. */
function upstreams({ voiceUp = true, human = true } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("turnstile")) return new Response(JSON.stringify({ success: human }));
    if (url.includes("/healthz")) return voiceUp ? new Response("ok") : new Response("", { status: 502 });
    throw new Error(`unexpected fetch ${url}`);
  }));
}

const RESULTS = (session_id: string) => ({
  session_id,
  status: "completed",
  end_reason: "hung_up",
  duration_seconds: 42,
  transcript: [
    { who: "agent", text: "Hi, this is Alex from Acme Clinic.", at_ms: 0 },
    { who: "person", text: "Can we do Wednesday?", at_ms: 4200 },
  ],
  outcome: { confirmed: false, new_time: "Wednesday 2:30 PM" },
  summary: "Moved to Wednesday 2:30 PM.",
  latency: [640],
});

describe("a demo call, end to end", () => {
  it("creates a session, claims it once, stores results and shows them", async () => {
    upstreams();
    const res = await start({ use_case: "appointment-confirmation" });
    expect(res.status).toBe(201);
    const s: any = await res.json();
    expect(s.voice_url).toBe("ws://voice.test/ws");
    expect(s.calls_left).toBe(1);
    expect(s.plan.agent.name).toBe("Alex");

    const claimed = await signed("/internal/claim", { ticket: s.ticket });
    expect(claimed.status).toBe(200);
    const c: any = await claimed.json();
    expect(c).toMatchObject({ session_id: s.session_id, max_seconds: 120, wrap_up_seconds: 15, silence_seconds: 20 });
    expect(c.plan.instructions).toContain("appointment");
    expect((await signed("/internal/claim", { ticket: s.ticket })).status).toBe(409);

    expect((await signed("/internal/results", RESULTS(s.session_id))).status).toBe(200);
    expect((await signed("/internal/results", RESULTS(s.session_id))).status).toBe(409);

    const got: any = await (await call(`/sessions/${s.session_id}`, { headers: SITE })).json();
    expect(got).toMatchObject({ status: "completed", end_reason: "hung_up", use_case: "appointment-confirmation", summary: "Moved to Wednesday 2:30 PM." });
    expect(got.transcript).toHaveLength(2);
    expect(got.outcome.new_time).toBe("Wednesday 2:30 PM");
    expect(got.plan.instructions).toBeUndefined();
  });

  it("runs a visitor's own plan after validating it", async () => {
    upstreams();
    const plan = {
      agent: { name: "Maya", company: "Parcelly", role: "customer care" },
      person: "the customer", brief: "Your parcel didn't come.", goal: "Find a new day.",
      firstMessage: "Hi, this is Maya.", instructions: "Ask which day works.", fields: [{ key: "new_day", label: "New day" }],
    };
    expect((await start({ plan })).status).toBe(201);
    const bad = await start({ plan: { ...plan, fields: [] } });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error).toBe("invalid_plan");
    expect((await start({ use_case: "nope" })).status).toBe(400);
  });
});

describe("POST /sessions refusals", () => {
  it("says offline when the voice server is down, without using a call", async () => {
    upstreams({ voiceUp: false });
    const res = await start({ use_case: "lead-qualification" });
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toBe("offline");
    expect(db.prepare("SELECT COUNT(*) AS n FROM demo_sessions").get()).toEqual({ n: 0 });
  });
  it("needs the bot check", async () => {
    upstreams({ human: false });
    expect((await start({ use_case: "lead-qualification" })).status).toBe(403);
  });
  it("stops a visitor at their daily calls", async () => {
    upstreams();
    expect((await start({ use_case: "lead-qualification" })).status).toBe(201);
    expect((await start({ use_case: "lead-qualification" })).status).toBe(201);
    const res = await start({ use_case: "lead-qualification" });
    expect(res.status).toBe(429);
    expect((await res.json() as any).error).toBe("limit_reached");
  });
  it("says lines are busy at the concurrency limit", async () => {
    ({ env, db } = testEnv({ MAX_CONCURRENT: "1" }));
    upstreams();
    expect((await start({ use_case: "lead-qualification" }, 1)).status).toBe(201);
    const res = await start({ use_case: "lead-qualification" }, 2);
    expect(res.status).toBe(503);
    expect((await res.json() as any).error).toBe("lines_busy");
  });
});

describe("internal routes", () => {
  it("refuse unsigned, wrongly signed and forged-ticket requests", async () => {
    upstreams();
    const s: any = await (await start({ use_case: "lead-qualification" })).json();
    const plain = await call("/internal/claim", { method: "POST", body: JSON.stringify({ ticket: s.ticket }) });
    expect(plain.status).toBe(401);
    expect((await signed("/internal/claim", { ticket: s.ticket }, "wrong")).status).toBe(401);
    expect((await signed("/internal/claim", { ticket: "abc.def" })).status).toBe(403);
    expect((await signed("/internal/results", { ...RESULTS(s.session_id), end_reason: "bored" })).status).toBe(400);
  });
  it("aren't reachable cross-origin with CORS", async () => {
    const res = await call("/internal/claim", { method: "OPTIONS", headers: { origin: "https://offhook.welldun.ai" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /status and /sessions/{id}", () => {
  it("reports online, busy and paused", async () => {
    ({ env, db } = testEnv({ MAX_CONCURRENT: "1" }));
    upstreams();
    expect(await (await call("/status", { headers: SITE })).json()).toEqual({ online: true, busy: false, paused: false });
    await start({ use_case: "lead-qualification" });
    expect(await (await call("/status", { headers: SITE })).json()).toEqual({ online: true, busy: true, paused: false });
  });
  it("404s unknown and malformed IDs", async () => {
    expect((await call("/sessions/not-a-uuid")).status).toBe(404);
    expect((await call("/sessions/3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b")).status).toBe(404);
  });
});

describe("cleanup", () => {
  it("expires never-connected sessions and deletes day-old ones", async () => {
    upstreams();
    const s: any = await (await start({ use_case: "lead-qualification" })).json();
    await cleanup(env, Date.now() + 61_000);
    expect(db.prepare("SELECT status FROM demo_sessions").get()).toEqual({ status: "expired" });
    await cleanup(env, Date.now() + 24 * 3600_000 + 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM demo_sessions").get()).toEqual({ n: 0 });
    expect((await call(`/sessions/${s.session_id}`)).status).toBe(404);
  });
});

describe("POST /waitlist", () => {
  const join = (body: unknown, n = 1) => call("/waitlist", { method: "POST", headers: visitor(n), body: JSON.stringify({ turnstile_token: "x", ...(body as object) }) });
  it("adds an entry, and a repeat signup updates it without saying so", async () => {
    upstreams();
    expect(await (await join({ email: "priya@example.com", use_case: "Recruiting" })).json()).toEqual({ ok: true });
    expect(await (await join({ email: "PRIYA@example.com", company: "Northwind" })).json()).toEqual({ ok: true });
    expect(db.prepare("SELECT email, company, use_case FROM waitlist_entries").all()).toEqual([
      { email: "priya@example.com", company: "Northwind", use_case: "Recruiting" },
    ]);
  });
  it("rejects bad emails and failed bot checks", async () => {
    upstreams({ human: false });
    expect((await join({ email: "nope" })).status).toBe(400);
    expect((await join({ email: "a@b.co" })).status).toBe(403);
  });
});

describe("POST /internal/reset", () => {
  it("clears today's visitor counts, only when signed", async () => {
    upstreams();
    expect((await start({ use_case: "lead-qualification" })).status).toBe(201);
    expect((await start({ use_case: "lead-qualification" })).status).toBe(201);
    expect((await start({ use_case: "lead-qualification" })).status).toBe(429);
    expect((await call("/internal/reset", { method: "POST", body: "{}" })).status).toBe(401);
    const res = await signed("/internal/reset", {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).cleared).toBeGreaterThan(0);
    expect((await start({ use_case: "lead-qualification" })).status).not.toBe(429);
  });
});
