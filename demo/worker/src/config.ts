// The Worker's bindings and the limits derived from them.
import type { Gate } from "./gate";
import type { CallLimits } from "./lines";

export interface Env {
  ALLOWED_ORIGINS: string;
  PLANNER_MODEL: string;
  VOICE_URL: string;
  DAILY_PLANS_PER_VISITOR: string;
  DAILY_CALLS_PER_VISITOR: string;
  MAX_CALL_SECONDS: string;
  MAX_CONCURRENT: string;
  DAILY_MINUTES_CAP: string;
  GROQ_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  VISITOR_HASH_SALT: string;
  DEMO_HMAC_SECRET: string;
  GATE: DurableObjectNamespace<Gate>;
  DB: D1Database;
}

/** Seconds a new session waits for the voice server to claim it before its line is freed. */
export const CONNECT_SECONDS = 60;
/** Seconds of silence (nobody talking) that end a call. Enforced by the voice server. */
export const SILENCE_SECONDS = 20;
/** Seconds before the end at which the agent is told to wrap up. Enforced by the voice server. */
export const WRAP_UP_SECONDS = 15;
/** How long sessions (transcripts and results) are kept. */
export const KEEP_MS = 24 * 60 * 60 * 1000;

/** Returns the call limits from the Worker's vars. */
export function callLimits(env: Env): CallLimits {
  return {
    perVisitor: Number(env.DAILY_CALLS_PER_VISITOR),
    concurrent: Number(env.MAX_CONCURRENT),
    dailySeconds: Number(env.DAILY_MINUTES_CAP) * 60,
    maxSeconds: Number(env.MAX_CALL_SECONDS),
    connectSeconds: CONNECT_SECONDS,
  };
}

/** Returns the one Gate instance. */
export function gateOf(env: Env): DurableObjectStub<Gate> {
  return env.GATE.get(env.GATE.idFromName("gate"));
}
