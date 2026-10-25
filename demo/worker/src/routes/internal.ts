// Routes only the voice server calls. Every request is HMAC-signed (see sign.ts).
import { callLimits, gateOf, SILENCE_SECONDS, WRAP_UP_SECONDS, type Env } from "../config";
import { json, problem, readJson } from "../http";
import { readTicket, verifyRequest } from "../sign";

const END_REASONS = ["hung_up", "agent_ended", "time_limit", "silence", "disconnected", "error"] as const;
const MAX_TURNS = 300;

/**
 * POST /internal/claim: {ticket} → the session's plan, exactly once.
 * The voice server calls this when a browser connects with a ticket. The ticket must be
 * genuine and unexpired, and the Gate must not have seen it claimed before.
 * Args: request — signed by the voice server; env — vars, secrets and bindings.
 * Returns: 200 {session_id, plan, max_seconds, wrap_up_seconds, silence_seconds};
 *   401 bad signature; 403 bad ticket; 409 already claimed or expired.
 */
export async function claim(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const body = await signedBody(request, env, now);
  if (body instanceof Response) return body;
  const id = await readTicket(env.DEMO_HMAC_SECRET, body.ticket, now);
  if (!id) return problem("bad_ticket", "The ticket is invalid or expired.", 403);

  const limits = callLimits(env);
  if (!(await gateOf(env).claimCall(id, now, limits))) {
    return problem("already_claimed", "This ticket was already used, or the session timed out.", 409);
  }
  const row = await env.DB.prepare("UPDATE demo_sessions SET status = 'live', started_at = ? WHERE id = ? AND status = 'created' RETURNING plan")
    .bind(now, id)
    .first<{ plan: string }>();
  if (!row) {
    await gateOf(env).finishCall(id, 0, limits);
    return problem("already_claimed", "This session isn't waiting for a call.", 409);
  }
  return json({
    session_id: id,
    plan: JSON.parse(row.plan),
    max_seconds: limits.maxSeconds,
    wrap_up_seconds: WRAP_UP_SECONDS,
    silence_seconds: SILENCE_SECONDS,
  });
}

/**
 * POST /internal/results: what happened on a call. Frees its line, charges the seconds
 * it used, and stores the transcript and results for the results page.
 * Args: request — signed by the voice server; env — vars, secrets and bindings.
 * Returns: 200 {ok}; 400 invalid results; 401 bad signature; 409 not a live session.
 */
export async function results(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const body = await signedBody(request, env, now, 262_144);
  if (body instanceof Response) return body;
  const r = checkResults(body);
  if ("error" in r) return problem("invalid_results", r.error, 400);

  const row = await env.DB.prepare(
    `UPDATE demo_sessions SET status = ?, ended_at = ?, end_reason = ?, transcript = ?, outcome = ?, summary = ?, latency = ?
     WHERE id = ? AND status = 'live' RETURNING id`,
  )
    .bind(r.status, now, r.end_reason, JSON.stringify(r.transcript), JSON.stringify(r.outcome), r.summary, JSON.stringify(r.latency), r.session_id)
    .first();
  await gateOf(env).finishCall(r.session_id, r.duration_seconds, callLimits(env));
  if (!row) return problem("not_live", "That session isn't live.", 409);
  return json({ ok: true });
}

export interface Results {
  session_id: string;
  status: "completed" | "failed";
  end_reason: (typeof END_REASONS)[number];
  duration_seconds: number;
  transcript: { who: "agent" | "person"; text: string; at_ms: number }[];
  outcome: Record<string, string | number | boolean | null>;
  summary: string | null;
  latency: number[];
}

/**
 * Validates a results body from the voice server; it's trusted, but a bug there
 * shouldn't put junk in front of visitors.
 * Args: d — the parsed body.
 * Returns: the typed results, or an error naming the bad part.
 */
export function checkResults(d: Record<string, unknown>): Results | { error: string } {
  if (typeof d.session_id !== "string") return { error: "session_id" };
  if (d.status !== "completed" && d.status !== "failed") return { error: "status" };
  if (!END_REASONS.includes(d.end_reason as Results["end_reason"])) return { error: "end_reason" };
  const duration = d.duration_seconds;
  if (typeof duration !== "number" || !(duration >= 0) || duration > 3600) return { error: "duration_seconds" };

  const t = d.transcript;
  if (!Array.isArray(t) || t.length > MAX_TURNS) return { error: "transcript" };
  for (const turn of t) {
    if (!turn || (turn.who !== "agent" && turn.who !== "person") || typeof turn.text !== "string" || turn.text.length > 2000 || typeof turn.at_ms !== "number") {
      return { error: "transcript turn" };
    }
  }
  const o = d.outcome ?? {};
  if (typeof o !== "object" || Array.isArray(o) || Object.keys(o).length > 10) return { error: "outcome" };
  for (const v of Object.values(o)) {
    if (v !== null && !["string", "number", "boolean"].includes(typeof v)) return { error: "outcome value" };
    if (typeof v === "string" && v.length > 500) return { error: "outcome value" };
  }
  const summary = d.summary ?? null;
  if (summary !== null && (typeof summary !== "string" || summary.length > 1000)) return { error: "summary" };
  const latency = d.latency ?? [];
  if (!Array.isArray(latency) || latency.length > MAX_TURNS || latency.some((n) => typeof n !== "number" || n < 0)) return { error: "latency" };

  return {
    session_id: d.session_id,
    status: d.status,
    end_reason: d.end_reason as Results["end_reason"],
    duration_seconds: duration,
    transcript: t,
    outcome: o as Results["outcome"],
    summary: summary as string | null,
    latency: latency as number[],
  };
}

/**
 * Reads and authenticates a signed JSON body.
 * Args: request, env — as for the routes; now — unix ms; maxBytes — the size cap.
 * Returns: the body, or a 400/401 response.
 */
async function signedBody(request: Request, env: Env, now: number, maxBytes?: number): Promise<Record<string, unknown> | Response> {
  const body = await readJson(request.clone(), maxBytes);
  const text = body?.text ?? (await request.text());
  if (!(await verifyRequest(env.DEMO_HMAC_SECRET, request.headers, text, now))) {
    return problem("unauthorized", "Bad or missing signature.", 401);
  }
  return body ? body.data : problem("invalid_json", "Send a JSON object.", 400);
}
