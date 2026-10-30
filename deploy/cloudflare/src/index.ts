// Hosted Offhook on Cloudflare (CLOUDFLARE.md): a Worker in front of one container
// that runs the API, the call worker and the demo voice server (app/cloud.py).
import { Container } from "@cloudflare/containers";

/** Settings passed into the container: vars from wrangler.jsonc and secrets. */
const PASS_THROUGH = [
  // vars
  "ENV", "LOG_LEVEL", "PUBLIC_BASE_URL", "CORS_ORIGINS", "ENABLE_PREBUILT_UI", "WEBHOOK_ALLOW_PRIVATE",
  "CLERK_ISSUER", "MASTER_KEY_ID", "WORKER_URL", "DEMO_ALLOWED_ORIGINS",
  // secrets
  "DATABASE_URL", "MASTER_ENCRYPTION_KEY",
  "PLATFORM_DEEPGRAM_API_KEY", "PLATFORM_CARTESIA_API_KEY", "PLATFORM_CARTESIA_VOICE_ID", "PLATFORM_GROQ_API_KEY",
  "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID", "GROQ_API_KEY", "DEMO_HMAC_SECRET",
] as const;

type Env = Record<(typeof PASS_THROUGH)[number], string> & {
  APP: DurableObjectNamespace<OffhookApp>;
  /** Overrides the idle timer, e.g. "90s" for testing that calls keep it awake. */
  SLEEP_AFTER?: string;
};

export class OffhookApp extends Container<Env> {
  defaultPort = 8080;
  // Sleep five minutes after the last request, unless a call is still running.
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    if (env.SLEEP_AFTER) this.sleepAfter = env.SLEEP_AFTER;
    this.envVars = Object.fromEntries(PASS_THROUGH.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  }

  /**
   * The idle timer ran out. WebSocket audio isn't reliably counted as activity,
   * so ask the app whether a call is in progress before stopping.
   */
  override async onActivityExpired(): Promise<void> {
    try {
      const res = await this.containerFetch("http://container/_activity");
      const { calls } = (await res.json()) as { calls: number };
      if (calls > 0) {
        console.log(`[offhook] idle timer: ${calls} call(s) running; staying awake`);
        this.renewActivityTimeout();
        return;
      }
      console.log("[offhook] idle timer: no calls; going to sleep");
    } catch (e) {
      console.log(`[offhook] activity check failed (${String(e)}); stopping`);
    }
    await this.stop();
  }

  override onError(error: unknown): void {
    console.error("[offhook] container error", error);
    throw error;
  }
}

/**
 * What may wake the container. Bots probe every new address ("/", "/robots.txt",
 * "/wp-login.php"…), and the website asks whether the demo is online on every
 * visit; answering those here keeps the container asleep until real work arrives.
 * Args: url — the request URL.
 * Returns: the path to forward to the app, or a Response to send without waking it.
 */
function route(url: URL): string | Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname.startsWith("voice")) {
    // The demo's voice server: only a call wakes the container; it starts within
    // the ticket's minute, so "online" is true whenever the Worker is up.
    if (url.pathname === "/ws") return "/demo/ws";
    if (url.pathname === "/healthz") return json({ ok: true, calls: null });
    return json({ error: "not_found" }, 404);
  }
  if (url.pathname.startsWith("/v1/")) return url.pathname;
  if (url.pathname === "/healthz") return json({ status: "ok" });
  return json({ detail: "Not Found" }, 404);
}

export default {
  /**
   * Forwards API requests and calls (WebSockets included) to the one container
   * instance; answers everything else itself (see route()).
   * Args: request — the incoming request; env — vars, secrets and the container binding.
   * Returns: the app's response, or the Worker's own.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const target = route(url);
    if (target instanceof Response) return target;
    if (target !== url.pathname) {
      url.pathname = target;
      request = new Request(url, request);
    }
    return env.APP.getByName("main").fetch(request);
  },
};
