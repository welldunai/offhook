import { gateOf, type Env } from "../config";
import { json, problem, readJson, withCookie } from "../http";
import { checkPurpose, planCall, PlannerError } from "../plan";
import { verifyTurnstile } from "../turnstile";
import { identify, secondsToReset, utcDay } from "../visitor";

/**
 * POST /plans: {purpose, turnstile_token} → a call plan or a refusal.
 * Order matters: cheap checks first, then Turnstile, then the daily limit, then Groq.
 * A planner failure gives the visitor's plan back.
 * Args: request — must carry a JSON body; env — vars, secrets and bindings.
 * Returns: 200 with the PlanResult and plans_left; 400 bad input; 403 failed bot check;
 *   429 daily limit reached; 502 planner failed.
 */
export async function createPlan(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body) return problem("invalid_json", "Send a JSON object.", 400);
  const checked = checkPurpose(body.data.purpose);
  if ("error" in checked) return problem("invalid_purpose", checked.error, 400);

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await verifyTurnstile(body.data.turnstile_token, env.TURNSTILE_SECRET_KEY, ip))) return botCheckFailed();

  const day = utcDay();
  const visitor = await identify(request, env.VISITOR_HASH_SALT, day);
  const gate = gateOf(env);
  const limit = Number(env.DAILY_PLANS_PER_VISITOR);
  const taken = await gate.take("plan", visitor.keys, limit, day);
  if (!taken.ok) {
    return withCookie(limitReached(`You've planned ${limit} calls today. Try again tomorrow.`), visitor.setCookie);
  }

  try {
    const result = await planCall(checked.purpose, { apiKey: env.GROQ_API_KEY, model: env.PLANNER_MODEL });
    return withCookie(json({ ...result, plans_left: taken.left }), visitor.setCookie);
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    console.error("planner failed:", e.message);
    await gate.refund("plan", visitor.keys, day);
    return withCookie(problem("planner_failed", "We couldn't plan that call just now. Try again in a moment.", 502), visitor.setCookie);
  }
}

/** 403 for a failed Turnstile check. */
export function botCheckFailed(): Response {
  return problem("bot_check_failed", "We couldn't check you're human. Reload the page and try again.", 403);
}

/** 429 for a daily limit, with Retry-After set to the next UTC midnight. */
export function limitReached(message: string): Response {
  const retry = secondsToReset();
  const res = problem("limit_reached", message, 429, { retry_after: retry });
  res.headers.set("retry-after", String(retry));
  return res;
}
