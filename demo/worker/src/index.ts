// demo.offhook.welldun.ai: the live demo's public API (DEMO.md, milestone 2).
// So far: the use cases, and the planner behind Turnstile and a daily per-visitor
// limit. Sessions, the voice server's callbacks and the waitlist come next.
import { USE_CASES } from "../../../site/src/use-cases";
import type { Gate } from "./gate";
import { checkPurpose, planCall, PlannerError } from "./plan";
import { verifyTurnstile } from "./turnstile";
import { identify, secondsToReset, utcDay } from "./visitor";

export { Gate } from "./gate";

export interface Env {
  ALLOWED_ORIGINS: string;
  PLANNER_MODEL: string;
  DAILY_PLANS_PER_VISITOR: string;
  GROQ_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  VISITOR_HASH_SALT: string;
  GATE: DurableObjectNamespace<Gate>;
  DB: D1Database;
}

export default {
  /**
   * Routes a request and adds CORS headers for allowed origins.
   * Args: request — the incoming request; env — vars, secrets and bindings.
   * Returns: the JSON response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const allowed = origin !== null && env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).includes(origin);
    if (origin !== null && !allowed) return json({ error: "origin_not_allowed" }, 403);

    let res: Response;
    if (request.method === "OPTIONS") res = new Response(null, { status: 204 });
    else res = await route(request, env);

    if (allowed) {
      res.headers.set("access-control-allow-origin", origin!);
      res.headers.set("access-control-allow-credentials", "true"); // the visitor cookie
      res.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
      res.headers.set("access-control-allow-headers", "content-type");
      res.headers.set("access-control-max-age", "86400");
      res.headers.append("vary", "origin");
    }
    return res;
  },
};

/**
 * Dispatches by method and path.
 * Args: request — the incoming request; env — vars, secrets and bindings.
 * Returns: the route's response, or 404/405.
 */
async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/use-cases") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json({ use_cases: USE_CASES }); // the same data the site's use-case pages show
  }
  if (pathname === "/plans") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return createPlan(request, env);
  }
  return json({ error: "not_found" }, 404);
}

/**
 * POST /plans: {purpose, turnstile_token} → a call plan or a refusal.
 * Order matters: cheap checks first, then Turnstile, then the daily limit, then Groq.
 * A planner failure gives the visitor's plan back.
 * Args: request — must carry a JSON body; env — vars, secrets and bindings.
 * Returns: 200 with the PlanResult and plans_left; 400 bad input; 403 failed bot check;
 *   429 daily limit reached; 502 planner failed.
 */
async function createPlan(request: Request, env: Env): Promise<Response> {
  let body: { purpose?: unknown; turnstile_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const checked = checkPurpose(body?.purpose);
  if ("error" in checked) return json({ error: "invalid_purpose", message: checked.error }, 400);

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await verifyTurnstile(body.turnstile_token, env.TURNSTILE_SECRET_KEY, ip))) {
    return json({ error: "bot_check_failed", message: "We couldn't check you're human. Reload the page and try again." }, 403);
  }

  const day = utcDay();
  const visitor = await identify(request, env.VISITOR_HASH_SALT, day);
  const gate = env.GATE.get(env.GATE.idFromName("gate"));
  const limit = Number(env.DAILY_PLANS_PER_VISITOR);
  const taken = await gate.take("plan", visitor.keys, limit, day);
  if (!taken.ok) {
    const retry = secondsToReset();
    const res = json(
      { error: "limit_reached", message: `You've planned ${limit} calls today. Try again tomorrow.`, retry_after: retry },
      429,
    );
    res.headers.set("retry-after", String(retry));
    return withCookie(res, visitor.setCookie);
  }

  try {
    const result = await planCall(checked.purpose, { apiKey: env.GROQ_API_KEY, model: env.PLANNER_MODEL });
    return withCookie(json({ ...result, plans_left: taken.left }), visitor.setCookie);
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    console.error("planner failed:", e.message);
    await gate.refund("plan", visitor.keys, day);
    return withCookie(
      json({ error: "planner_failed", message: "We couldn't plan that call just now. Try again in a moment." }, 502),
      visitor.setCookie,
    );
  }
}

/** Adds the visitor cookie to `res` when one needs setting; returns `res`. */
function withCookie(res: Response, setCookie: string | undefined): Response {
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
}

/** Returns `data` as a JSON response with `status`. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
