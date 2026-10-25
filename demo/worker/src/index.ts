// demo.offhook.welldun.ai: the live demo's public API (DEMO.md, milestone 2).
// Step 2a has the read-only routes and the planner. Turnstile, per-visitor limits
// (the Gate), sessions and the waitlist are added in the next steps.
import { USE_CASES } from "../../../site/src/use-cases";
import { checkPurpose, planCall, PlannerError } from "./plan";

export interface Env {
  ALLOWED_ORIGINS: string;
  PLANNER_MODEL: string;
  GROQ_API_KEY: string;
}

export default {
  /**
   * Routes a request and adds CORS headers for allowed origins.
   * Args: request — the incoming request; env — vars and secrets.
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
 * Args: request — the incoming request; env — vars and secrets.
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
 * POST /plans: {purpose} → a call plan or a refusal.
 * Args: request — must carry a JSON body; env — needs GROQ_API_KEY and PLANNER_MODEL.
 * Returns: 200 with the PlanResult, 400 for a bad purpose, 502 if the planner fails.
 */
async function createPlan(request: Request, env: Env): Promise<Response> {
  let body: { purpose?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const checked = checkPurpose(body?.purpose);
  if ("error" in checked) return json({ error: "invalid_purpose", message: checked.error }, 400);
  try {
    return json(await planCall(checked.purpose, { apiKey: env.GROQ_API_KEY, model: env.PLANNER_MODEL }));
  } catch (e) {
    if (!(e instanceof PlannerError)) throw e;
    console.error("planner failed:", e.message);
    return json({ error: "planner_failed", message: "We couldn't plan that call just now. Try again in a moment." }, 502);
  }
}

/** Returns `data` as a JSON response with `status`. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
