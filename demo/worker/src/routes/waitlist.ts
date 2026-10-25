import { gateOf, type Env } from "../config";
import { json, problem, readJson, withCookie } from "../http";
import { verifyTurnstile } from "../turnstile";
import { identify, utcDay } from "../visitor";
import { botCheckFailed, limitReached } from "./plans";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAILY_SIGNUPS_PER_VISITOR = 5;

/**
 * POST /waitlist: {email, company?, use_case?, turnstile_token}.
 * Signing up twice updates the entry and answers the same, so the response never
 * reveals whether an email is already on the list.
 * Args: request — the incoming request; env — vars, secrets and bindings.
 * Returns: 200 {ok}; 400 bad input; 403 bot check; 429 too many signups today.
 */
export async function joinWaitlist(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return problem("invalid_json", "Send a JSON object.", 400);
  const { email, company, use_case } = body.data;
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email.trim())) {
    return problem("invalid_email", "Enter a valid email address.", 400);
  }
  const optional = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

  if (!(await verifyTurnstile(body.data.turnstile_token, env.TURNSTILE_SECRET_KEY, request.headers.get("cf-connecting-ip")))) {
    return botCheckFailed();
  }
  const day = utcDay();
  const visitor = await identify(request, env.VISITOR_HASH_SALT, day);
  const taken = await gateOf(env).take("waitlist", visitor.keys, DAILY_SIGNUPS_PER_VISITOR, day);
  if (!taken.ok) return withCookie(limitReached("That's a lot of signups from here today. Try again tomorrow."), visitor.setCookie);

  await env.DB.prepare(
    `INSERT INTO waitlist_entries (email, company, use_case, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET company = COALESCE(excluded.company, company), use_case = COALESCE(excluded.use_case, use_case)`,
  )
    .bind(email.trim(), optional(company, 100), optional(use_case, 100), Date.now())
    .run();
  return withCookie(json({ ok: true }), visitor.setCookie);
}
