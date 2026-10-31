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

const DAY_OF = (col: string) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;

/**
 * POST /internal/stats: {days} → demo activity per UTC day, for the hosted
 * dashboard's stats page. Signed with DEMO_HMAC_SECRET. Counts only: no
 * transcripts, plans or emails leave the Worker.
 * Args: request — signed; env — bindings.
 * Returns: 200 {days: [{day, visitors, sessions, completed, failed, expired, custom,
 *   call_seconds, plans, plans_refused, plans_limited, waitlist}], use_cases: {slug|"custom": n}};
 *   400 bad days; 401 bad signature.
 */
export async function stats(request: Request, env: Env): Promise<Response> {
  const now = Date.now();
  const body = await signedBody(request, env, now);
  if (body instanceof Response) return body;
  const days = Number(body.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) return problem("invalid_days", "days must be 1 to 365.", 400);
  const since = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - (days - 1));

  const [sessions, plans, waitlist, visitors, useCases] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${DAY_OF("created_at")} AS day, COUNT(*) AS sessions,
         SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed, SUM(status = 'expired') AS expired,
         SUM(use_case IS NULL) AS custom,
         COALESCE(SUM(CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL THEN (ended_at - started_at) / 1000 END), 0) AS call_seconds
       FROM demo_sessions WHERE created_at >= ? GROUP BY day`,
    ).bind(since),
    env.DB.prepare(
      `SELECT ${DAY_OF("created_at")} AS day, SUM(outcome = 'planned') AS plans,
         SUM(outcome = 'refused') AS plans_refused, SUM(outcome = 'limited') AS plans_limited
       FROM plan_requests WHERE created_at >= ? GROUP BY day`,
    ).bind(since),
    env.DB.prepare(`SELECT ${DAY_OF("created_at")} AS day, COUNT(*) AS waitlist FROM waitlist_entries WHERE created_at >= ? GROUP BY day`).bind(since),
    // Visitor keys are salted per day, so distinct keys per day are distinct visitors that day.
    env.DB.prepare(
      `SELECT day, COUNT(DISTINCT visitor) AS visitors FROM (
         SELECT ${DAY_OF("created_at")} AS day, visitor FROM demo_sessions WHERE created_at >= ?1
         UNION ALL SELECT ${DAY_OF("created_at")} AS day, visitor FROM plan_requests WHERE created_at >= ?1
       ) GROUP BY day`,
    ).bind(since),
    env.DB.prepare(`SELECT COALESCE(use_case, 'custom') AS use_case, COUNT(*) AS n FROM demo_sessions WHERE created_at >= ? GROUP BY 1`).bind(since),
  ]);

  const byDay = new Map<string, Record<string, number | string>>();
  for (let t = since; t <= now; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, { day, visitors: 0, sessions: 0, completed: 0, failed: 0, expired: 0, custom: 0, call_seconds: 0, plans: 0, plans_refused: 0, plans_limited: 0, waitlist: 0 });
  }
  for (const result of [sessions, plans, waitlist, visitors]) {
    for (const row of result.results as Record<string, unknown>[]) {
      const entry = byDay.get(String(row.day));
      if (!entry) continue;
      for (const [k, v] of Object.entries(row)) if (k !== "day") entry[k] = Math.round(Number(v ?? 0));
    }
  }
  const use_cases = Object.fromEntries((useCases.results as { use_case: string; n: number }[]).map((r) => [r.use_case, r.n]));
  return json({ days: [...byDay.values()], use_cases });
}

/**
 * POST /internal/reset: {} → clears today's per-visitor counts (plans, calls,
 * signups). For the maintainer, signed with DEMO_HMAC_SECRET like the voice
 * server's calls. Lines in use and the day's minutes are left alone.
 * Args: request — signed; env — bindings.
 * Returns: 200 {cleared}; 401 bad signature.
 */
export async function resetUsage(request: Request, env: Env): Promise<Response> {
  const body = await signedBody(request, env, Date.now());
  if (body instanceof Response) return body;
  const cleared = await gateOf(env).clearUsage(new Date().toISOString().slice(0, 10));
  return json({ cleared });
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
