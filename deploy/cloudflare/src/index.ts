// Hosted Offhook on Cloudflare (CLOUDFLARE.md): a Worker in front of one container
// that runs the API, the call worker and the demo voice server (app/cloud.py).
import { Container } from "@cloudflare/containers";

// Required for the container's outbound requests to reach handlers in this Worker.
export { ContainerProxy } from "@cloudflare/containers";

/** Settings passed into the container: vars from wrangler.jsonc and secrets. */
const PASS_THROUGH = [
  // vars
  "ENV", "LOG_LEVEL", "PUBLIC_BASE_URL", "CORS_ORIGINS", "ENABLE_PREBUILT_UI", "WEBHOOK_ALLOW_PRIVATE",
  "CLERK_ISSUER", "MASTER_KEY_ID", "WORKER_URL", "DEMO_ALLOWED_ORIGINS", "RECORDINGS_URL",
  // secrets
  "DATABASE_URL", "MASTER_ENCRYPTION_KEY",
  "PLATFORM_DEEPGRAM_API_KEY", "PLATFORM_CARTESIA_API_KEY", "PLATFORM_CARTESIA_VOICE_ID", "PLATFORM_GROQ_API_KEY",
  "DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID", "GROQ_API_KEY", "DEMO_HMAC_SECRET",
] as const;

type Env = Record<(typeof PASS_THROUGH)[number], string> & {
  APP: DurableObjectNamespace<OffhookApp>;
  RECORDINGS: R2Bucket;
  /** Overrides the idle timer, e.g. "90s" for testing that calls keep it awake. */
  SLEEP_AFTER?: string;
};

/**
 * How long the app may report a call with no request or open socket before we
 * treat its count as stuck. Every call's audio is a WebSocket through this
 * Worker, and an open one already keeps the container awake; the count only
 * covers gaps such as an outbound call ringing, which take a minute or two.
 */
const MAX_HOLD_MS = 10 * 60 * 1000;

/** A recording's key: <workspace id>/<call id>.wav (app/recording.py). */
const RECORDING_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.wav$/;

/**
 * The container's recording store (RECORDINGS_URL=http://recordings.internal),
 * kept in R2. Only the container can reach it; it isn't on the internet.
 * Args: request — PUT with the WAV, or GET; env — the R2 binding.
 * Returns: 200 (with the WAV for GET), 404 if there's none, 400 for a bad key.
 */
async function recordings(request: Request, env: Env): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (!RECORDING_KEY.test(key)) return new Response("bad key", { status: 400 });
  if (request.method === "PUT") {
    await env.RECORDINGS.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: "audio/wav" } });
    return new Response(null, { status: 200 });
  }
  if (request.method === "GET") {
    const obj = await env.RECORDINGS.get(key);
    return obj ? new Response(obj.body, { headers: { "content-type": "audio/wav" } }) : new Response("not found", { status: 404 });
  }
  return new Response("method not allowed", { status: 405 });
}

export class OffhookApp extends Container<Env> {
  defaultPort = 8080;
  static outboundByHost = { "recordings.internal": recordings };
  // Sleep five minutes after the last request, unless a call is still running.
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    if (env.SLEEP_AFTER) this.sleepAfter = env.SLEEP_AFTER;
    this.envVars = Object.fromEntries(PASS_THROUGH.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  }

  /** When the idle timer first found a call running with nothing in flight. */
  private heldSince: number | undefined;

  /**
   * Forwards a request to the container; any request means the app is in use.
   * Args: request — the request from the Worker.
   * Returns: the container's response.
   */
  override async fetch(request: Request): Promise<Response> {
    this.heldSince = undefined;
    return super.fetch(request);
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
        this.heldSince ??= Date.now();
        if (Date.now() - this.heldSince < MAX_HOLD_MS) {
          console.log(`[offhook] idle timer: ${calls} call(s) running; staying awake`);
          this.renewActivityTimeout();
          return;
        }
        console.error(`[offhook] idle timer: ${calls} call(s) reported for 10 minutes with nothing in flight; count looks stuck, going to sleep`);
      } else {
        console.log("[offhook] idle timer: no calls; going to sleep");
      }
    } catch (e) {
      console.log(`[offhook] activity check failed (${String(e)}); stopping`);
    }
    this.heldSince = undefined;
    await this.stop();
  }

  /**
   * Logs whether recordings reach R2, once per start (see app/cloud.py). Runs in
   * the background so the request that woke the container doesn't wait for it.
   */
  override onStart(): void {
    const check = async () => {
      try {
        const res = await this.containerFetch("http://container/_recordings_check");
        console.log(`[offhook] recordings store: ${await res.text()}`);
      } catch (e) {
        console.error(`[offhook] recordings store check failed: ${String(e)}`);
      }
    };
    this.ctx.waitUntil(check());
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
