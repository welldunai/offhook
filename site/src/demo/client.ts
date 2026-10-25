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

/**
 * POSTs JSON to the demo API with the visitor cookie.
 * Args: path — e.g. "/plans"; body — the JSON body.
 * Returns: the parsed response. Throws DemoError with the API's message on failure.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  if (!DEMO_API) throw new DemoError("disabled", "The live demo isn't available here.");
  let res: Response;
  try {
    res = await fetch(DEMO_API + path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
