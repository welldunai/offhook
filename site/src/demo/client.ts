// The browser side of the live demo API (demo/worker). Every call goes through
// here, so error handling and the visitor's messages live in one place.

export const DEMO_API: string | undefined = import.meta.env.PUBLIC_DEMO_API;
const SITE_KEY: string | undefined = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;

/** True when this build knows where the demo backend is. */
export const demoEnabled = Boolean(DEMO_API && SITE_KEY);

export interface PlanField {
  key: string;
  label: string;
}

export interface Plan {
  agent: { name: string; company: string; role: string };
  person: string;
  brief: string;
  goal: string;
  firstMessage: string;
  instructions: string;
  assumptions: Record<string, string>;
  fields: PlanField[];
}

export type PlanResponse =
  | { status: "planned"; plan: Plan; plans_left: number }
  | { status: "refused"; reason: string; plans_left: number };

/** A failure the visitor should read: `message` is written for them. */
export class DemoError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * Plans a call from a plain-English purpose.
 * Args: purpose — what the visitor typed.
 * Returns: the plan or a refusal. Throws DemoError for limits, bot checks and outages.
 */
export async function planCall(purpose: string): Promise<PlanResponse> {
  return post<PlanResponse>("/plans", { purpose, turnstile_token: await turnstileToken() });
}

export interface SessionStart {
  session_id: string;
  ticket: string;
  voice_url: string;
  max_seconds: number;
  calls_left: number;
  plan: Plan;
}

/**
 * Starts a demo call: a launch use case by slug, or a plan from planCall.
 * Args: request — {use_case} or {plan}.
 * Returns: the session and its single-use ticket. Throws DemoError (offline, lines
 *   busy, daily limit, paused, bot check).
 */
export async function startSession(request: { use_case: string } | { plan: Plan }): Promise<SessionStart> {
  return post<SessionStart>("/sessions", { ...request, turnstile_token: await turnstileToken() });
}

export interface SessionResult {
  session_id: string;
  status: "created" | "live" | "completed" | "failed" | "expired";
  end_reason: string | null;
  transcript: { who: "agent" | "person"; text: string; at_ms: number }[];
  outcome: Record<string, string | number | boolean | null>;
  summary: string | null;
  latency: number[];
}

/**
 * Waits for a finished call's results. The voice server reports them a moment
 * after the socket closes, so this polls briefly.
 * Args: id — the session ID; tries — how many times to ask, a second apart.
 * Returns: the session once it's completed or failed, or the last answer.
 */
export async function waitForResults(id: string, tries = 10): Promise<SessionResult> {
  let last: SessionResult | null = null;
  for (let i = 0; i < tries; i++) {
    last = await get<SessionResult>(`/sessions/${id}`);
    if (last.status === "completed" || last.status === "failed") return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!last) throw new DemoError("unknown", "We couldn't load how the call went.");
  return last;
}

/**
 * Joins the hosted Offhook waitlist.
 * Args: entry — email, and optionally company and use case.
 * Throws DemoError with a message for the visitor.
 */
export async function joinWaitlist(entry: { email: string; company?: string; use_case?: string }): Promise<void> {
  await post("/waitlist", { ...entry, turnstile_token: await turnstileToken() });
}

/** GETs JSON from the demo API with the visitor cookie. */
async function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

/**
 * POSTs JSON to the demo API with the visitor cookie.
 * Args: path — e.g. "/plans"; body — the JSON body.
 * Returns: the parsed response. Throws DemoError with the API's message on failure.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/**
 * Calls the demo API.
 * Args: path — e.g. "/plans"; init — the fetch options.
 * Returns: the parsed response. Throws DemoError with the API's message on failure.
 */
async function request<T>(path: string, init: RequestInit): Promise<T> {
  if (!DEMO_API) throw new DemoError("disabled", "The live demo isn't available here.");
  let res: Response;
  try {
    res = await fetch(DEMO_API + path, { ...init, credentials: "include" });
  } catch {
    throw new DemoError("network", "We couldn't reach the demo. Check your connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new DemoError(data.error ?? "unknown", data.message ?? "Something went wrong. Try again in a moment.", data.retry_after);
  }
  return data as T;
}

// --- Turnstile -------------------------------------------------------------
// Loaded on first use, rendered once into a hidden-until-needed box, and asked
// for a fresh token per request (tokens are single use).

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let widget: Promise<{ api: TurnstileApi; id: string }> | null = null;
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

/** Returns a single-use Turnstile token, showing a challenge only if Cloudflare needs one. */
export async function turnstileToken(): Promise<string> {
  const { api, id } = await (widget ??= loadWidget());
  return new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
    api.reset(id);
    api.execute(id);
  });
}

/** Loads the Turnstile script and renders the widget. */
function loadWidget(): Promise<{ api: TurnstileApi; id: string }> {
  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.className = "demo-turnstile";
    document.body.append(box);
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onerror = () => {
      widget = null;
      reject(new DemoError("bot_check_failed", "We couldn't load the human check. Disable any blocker for this page and try again."));
    };
    script.onload = () => {
      const api = window.turnstile!;
      const id = api.render(box, {
        sitekey: SITE_KEY,
        execution: "execute",
        appearance: "interaction-only",
        callback: (token: string) => {
          pending?.resolve(token);
          pending = null;
        },
        "error-callback": () => {
          pending?.reject(new DemoError("bot_check_failed", "We couldn't check you're human. Reload the page and try again."));
          pending = null;
        },
      });
      resolve({ api, id });
    };
    document.head.append(script);
  });
}
