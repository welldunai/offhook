// Demo call sessions: the browser asks for one, gets a ticket, and later reads the results.
import { USE_CASES, type UseCase } from "../../../../site/src/use-cases";
import { callLimits, gateOf, KEEP_MS, type Env } from "../config";
import { json, problem, readJson, withCookie } from "../http";
import { parsePlanResult, PlannerError, type Plan } from "../plan";
import { makeTicket } from "../sign";
import { verifyTurnstile } from "../turnstile";
import { identify, utcDay } from "../visitor";
import { voiceOnline, voiceSocketUrl } from "../voice";
import { botCheckFailed, limitReached } from "./plans";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * POST /sessions: {use_case} or {plan}, plus turnstile_token → a session and its ticket.
 * Checks, in order: the body, Turnstile, the voice server, then the Gate (minute cap,
 * free line, the visitor's daily calls). Only then is the session stored.
 * Args: request — the incoming request; env — vars, secrets and bindings.
 * Returns: 201 {session_id, ticket, voice_url, max_seconds, calls_left, plan};
 *   400 bad input; 403 bot check; 429 visitor limit; 503 offline, lines busy or paused.
 */
export async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return problem("invalid_json", "Send a JSON object.", 400);
  const chosen = choosePlan(body.data);
  if ("error" in chosen) return problem("invalid_plan", chosen.error, 400);

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await verifyTurnstile(body.data.turnstile_token, env.TURNSTILE_SECRET_KEY, ip))) return botCheckFailed();
  if (!(await voiceOnline(env.VOICE_URL))) {
    return problem("offline", "The live demo is offline right now. Hear a sample call instead, or try again later.", 503);
  }

  const now = Date.now();
  const day = utcDay(new Date(now));
  const visitor = await identify(request, env.VISITOR_HASH_SALT, day);
  const limits = callLimits(env);
  const id = crypto.randomUUID();
  const started = await gateOf(env).startCall(id, visitor.keys, day, now, limits);
  if (!started.ok) {
    const res =
      started.reason === "limit_reached"
        ? limitReached(`You've made ${limits.perVisitor} demo calls today. Try again tomorrow.`)
        : started.reason === "lines_busy"
          ? problem("lines_busy", "All lines are busy. Try again in a minute.", 503, { retry_after: 60 })
          : problem("paused", "The live demo has used today's minutes. It's back tomorrow.", 503);
    return withCookie(res, visitor.setCookie);
  }

  await env.DB.prepare(
    `INSERT INTO demo_sessions (id, created_at, expires_at, status, use_case, plan, visitor)
     VALUES (?, ?, ?, 'created', ?, ?, ?)`,
  )
    .bind(id, now, now + KEEP_MS, chosen.useCase, JSON.stringify(chosen.plan), visitor.keys[0])
    .run();

  return withCookie(
    json(
      {
        session_id: id,
        ticket: await makeTicket(env.DEMO_HMAC_SECRET, id, now),
        voice_url: voiceSocketUrl(env.VOICE_URL),
        max_seconds: limits.maxSeconds,
        calls_left: started.callsLeft,
        plan: chosen.plan,
      },
      201,
    ),
    visitor.setCookie,
  );
}

/**
 * GET /sessions/{id}: status, transcript, results and timings, for 24 hours.
 * Args: id — the session ID from the path; env — bindings.
 * Returns: 200 with the session, or 404 if unknown or expired.
 */
export async function getSession(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) return problem("not_found", "No such call.", 404);
  const row = await env.DB.prepare("SELECT * FROM demo_sessions WHERE id = ? AND expires_at > ?")
    .bind(id, Date.now())
    .first<Record<string, unknown>>();
  if (!row) return problem("not_found", "No such call, or it's older than a day.", 404);
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : null);
  const plan = parse(row.plan) as Plan;
  return json({
    session_id: row.id,
    status: row.status,
    use_case: row.use_case,
    plan: { agent: plan.agent, person: plan.person, goal: plan.goal, fields: plan.fields },
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason,
    transcript: parse(row.transcript) ?? [],
    outcome: parse(row.outcome) ?? {},
    summary: row.summary,
    latency: parse(row.latency) ?? [],
  });
}

/**
 * Picks the plan a session runs: a launch use case by slug, or a visitor's plan,
 * validated with the same rules as the planner's output.
 * Args: data — the request body.
 * Returns: the plan and its use case slug (null for custom), or an error message.
 */
export function choosePlan(data: Record<string, unknown>): { plan: Plan; useCase: string | null } | { error: string } {
  if (data.use_case !== undefined) {
    const u = USE_CASES.find((c) => c.slug === data.use_case);
    return u ? { plan: useCasePlan(u), useCase: u.slug } : { error: "Unknown use case." };
  }
  if (data.plan !== undefined) {
    try {
      const r = parsePlanResult({ status: "planned", plan: data.plan });
      if (r.status === "planned") return { plan: r.plan, useCase: null };
    } catch (e) {
      if (e instanceof PlannerError) return { error: `The plan isn't valid: ${e.message}.` };
      throw e;
    }
  }
  return { error: "Pick a use case or send a plan." };
}

/** Returns a launch use case as a Plan. */
export function useCasePlan(u: UseCase): Plan {
  return {
    agent: u.agent,
    person: u.person,
    brief: u.brief,
    goal: u.goal,
    firstMessage: u.firstMessage,
    instructions: u.instructions,
    assumptions: u.context,
    fields: u.fields.map((f) => ({ key: f.key, label: f.label })),
  };
}
