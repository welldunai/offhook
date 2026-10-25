// demo.offhook.welldun.ai: the live demo's public API (DEMO.md, milestone 2).
import { USE_CASES } from "../../../site/src/use-cases";
import { cleanup } from "./cleanup";
import type { Env } from "./config";
import { json, problem } from "./http";
import { claim, resetUsage, results } from "./routes/internal";
import { createPlan } from "./routes/plans";
import { createSession, getSession } from "./routes/sessions";
import { status } from "./routes/status";
import { joinWaitlist } from "./routes/waitlist";

export { Gate } from "./gate";
export type { Env } from "./config";

export default {
  /**
   * Routes a request. Browser routes get CORS headers for allowed origins;
   * /internal/* is for the voice server and never gets them.
   * Args: request — the incoming request; env — vars, secrets and bindings.
   * Returns: the JSON response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/internal/")) return internal(pathname, request, env);

    const origin = request.headers.get("origin");
    const allowed = origin !== null && env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).includes(origin);
    if (origin !== null && !allowed) return json({ error: "origin_not_allowed" }, 403);

    const res = request.method === "OPTIONS" ? new Response(null, { status: 204 }) : await route(pathname, request, env);
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

  /**
   * The hourly cron (wrangler.toml [triggers]).
   * Args: _controller — the trigger; env — bindings; ctx — keeps the cleanup alive.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env));
  },
};

/**
 * Dispatches browser routes by method and path.
 * Args: pathname — the URL path; request — the incoming request; env — bindings.
 * Returns: the route's response, or 404/405.
 */
async function route(pathname: string, request: Request, env: Env): Promise<Response> {
  const m = request.method;
  const session = pathname.match(/^\/sessions\/([^/]+)$/);
  if (session) return m === "GET" ? getSession(session[1], env) : notAllowed();
  switch (pathname) {
    case "/use-cases":
      return m === "GET" ? json({ use_cases: USE_CASES }) : notAllowed(); // what the site's pages show
    case "/status":
      return m === "GET" ? status(env) : notAllowed();
    case "/plans":
      return m === "POST" ? createPlan(request, env) : notAllowed();
    case "/sessions":
      return m === "POST" ? createSession(request, env) : notAllowed();
    case "/waitlist":
      return m === "POST" ? joinWaitlist(request, env) : notAllowed();
  }
  return problem("not_found", "Not found.", 404);
}

/**
 * Dispatches the voice server's routes.
 * Args: pathname — the URL path; request — the incoming request; env — bindings.
 * Returns: the route's response, or 404/405.
 */
async function internal(pathname: string, request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return notAllowed();
  if (pathname === "/internal/claim") return claim(request, env);
  if (pathname === "/internal/results") return results(request, env);
  if (pathname === "/internal/reset") return resetUsage(request, env);
  return problem("not_found", "Not found.", 404);
}

/** 405 for a known path with the wrong method. */
function notAllowed(): Response {
  return problem("method_not_allowed", "Method not allowed.", 405);
}
