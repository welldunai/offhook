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

type Env = Record<(typeof PASS_THROUGH)[number], string> & { APP: DurableObjectNamespace<OffhookApp> };

export class OffhookApp extends Container<Env> {
  defaultPort = 8080;
  // Sleep five minutes after the last request, unless a call is still running.
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
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
        console.log(`[offhook] ${calls} call(s) running; staying awake`);
        this.renewActivityTimeout();
        return;
      }
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

export default {
  /**
   * Forwards every request (WebSockets included) to the one container instance.
   * voice.* hosts are the demo voice server, mounted at /demo in the app.
   * Args: request — the incoming request; env — vars, secrets and the container binding.
   * Returns: the app's response.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_activity") return new Response("Not found", { status: 404 });
    if (url.hostname.startsWith("voice")) {
      url.pathname = `/demo${url.pathname}`;
      request = new Request(url, request);
    }
    return env.APP.getByName("main").fetch(request);
  },
};
