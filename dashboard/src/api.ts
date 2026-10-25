// API client for the Offhook voice backend.
// The dashboard authenticates with a tenant API key (Bearer), stored locally.

const BASE = (import.meta.env.VITE_API_URL as string) || "http://localhost:8000";

// The dashboard authenticates with the signed-in user's Clerk session token.
// App.tsx wires this up from Clerk's getToken() once the user is signed in.
let tokenGetter: (() => Promise<string | null>) | null = null;
export function setTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = tokenGetter ? await tokenGetter() : null;
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- types ----
export interface Stats {
  total_calls: number;
  by_status: Record<string, number>;
  by_error_code: Record<string, number>;
  failure_rate: number;
  total_seconds: number;
  avg_seconds: number;
}
export interface CallSummary {
  id: string;
  status: string;
  direction: string;
  to_number: string | null;
  from_number: string | null;
  provider_call_id: string | null;
  error_code: string | null;
  duration_seconds: number | null;
  tags: Record<string, string>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  has_recording?: boolean;
}
export interface CallEvent {
  type: string;
  data: Record<string, unknown>;
  error_code: string | null;
  ts: string;
}
export interface Transcript {
  call_id: string;
  status: string;
  summary: string | null;
  transcript: { role: string; text: string; t: number }[];
}
export interface ApiKey {
  id: string;
  prefix: string;
  name: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
}
export interface Me {
  tenant_id: string;
  principal: string;
  email: string | null;
  user_id: string | null;
}
export interface Connection {
  id: string;
  name: string;
  provider_kind: string;
  provider_name: string;
  created_at: string;
}
export interface Agent {
  id: string;
  name: string;
  company: string | null;
  instructions: string;
  first_message: string | null;
  stt_connection_id: string | null;
  tts_connection_id: string | null;
  llm_connection_id: string | null;
  telephony_connection_id: string | null;
  tool_ids: string[];
  created_at: string;
}
export interface Tool {
  id: string;
  name: string;
  description: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  method: string;
  url: string;
  has_auth: boolean;
  timeout_seconds: number;
  created_at: string;
}
export interface ToolInput {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown>; required: string[] };
  method: string;
  url: string;
  headers: Record<string, string>;
  timeout_seconds: number;
}
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}
export interface PhoneNumber {
  id: string;
  e164: string;
  agent_id: string;
  created_at: string;
}
export interface Usage {
  total_seconds: number;
  call_count: number;
}
export type Providers = Record<string, string[] | Record<string, string[]>>;

const qs = (p: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  Object.entries(p).forEach(([k, v]) => v !== undefined && v !== "" && s.set(k, String(v)));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export interface TestCallTicket {
  ticket: string;
  ws_url: string;
  max_seconds: number;
}

export const api = {
  /** A single-use ticket to talk to an agent in the browser (not a phone call). */
  testCall: (agentId: string, context: Record<string, unknown> = {}) =>
    req<TestCallTicket>(`/v1/agents/${agentId}/test-call`, { method: "POST", body: JSON.stringify({ context }) }),

  me: () => req<Me>("/v1/me"),
  validate: () => req<Providers>("/v1/providers"),
  providers: () => req<Providers>("/v1/providers"),
  stats: (p: { since?: string; until?: string } = {}) => req<Stats>(`/v1/stats${qs(p)}`),
  usage: () => req<Usage>("/v1/usage"),

  calls: (p: { status?: string; direction?: string; to_number?: string; from_number?: string;
               error_code?: string; tags?: string[]; limit?: number; offset?: number } = {}) => {
    // tags is a repeatable `tag=key:value` param; the rest are single-valued.
    const { tags, ...rest } = p;
    const s = new URLSearchParams();
    Object.entries(rest).forEach(([k, v]) => v !== undefined && v !== "" && s.set(k, String(v)));
    (tags || []).forEach((t) => s.append("tag", t));
    const str = s.toString();
    return req<CallSummary[]>(`/v1/calls${str ? `?${str}` : ""}`);
  },
  createCall: (b: { agent_id: string; to_number: string; from_number?: string;
                    context?: Record<string, unknown>; tags?: Record<string, string> }) =>
    req<{ id: string; status: string; direction: string; provider_call_id: string | null }>("/v1/calls", {
      method: "POST",
      body: JSON.stringify(b),
    }),
  call: (id: string) => req<CallSummary>(`/v1/calls/${id}`),
  recordingUrl: async (id: string): Promise<string> => {
    const token = tokenGetter ? await tokenGetter() : null;
    const res = await fetch(`${BASE}/v1/calls/${id}/recording`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, "recording unavailable");
    return URL.createObjectURL(await res.blob());
  },
  callEvents: (id: string) => req<CallEvent[]>(`/v1/calls/${id}/events`),
  callTranscript: (id: string) => req<Transcript>(`/v1/calls/${id}/transcript`),

  apiKeys: () => req<ApiKey[]>("/v1/api-keys"),
  createApiKey: (name: string, expires_in_days?: number) =>
    req<{ id: string; prefix: string; key: string; expires_at: string | null }>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, expires_in_days: expires_in_days ?? null }),
    }),
  revokeApiKey: (id: string) => req<void>(`/v1/api-keys/${id}`, { method: "DELETE" }),

  connections: () => req<Connection[]>("/v1/connections"),
  createConnection: (b: { name: string; provider_kind: string; provider_name: string; secrets: Record<string, string> }) =>
    req<Connection>("/v1/connections", { method: "POST", body: JSON.stringify(b) }),
  deleteConnection: (id: string) => req<void>(`/v1/connections/${id}`, { method: "DELETE" }),

  agents: () => req<Agent[]>("/v1/agents"),
  createAgent: (b: Record<string, unknown>) =>
    req<Agent>("/v1/agents", { method: "POST", body: JSON.stringify(b) }),
  deleteAgent: (id: string) => req<void>(`/v1/agents/${id}`, { method: "DELETE" }),

  tools: () => req<Tool[]>("/v1/tools"),
  createTool: (b: ToolInput) => req<Tool>("/v1/tools", { method: "POST", body: JSON.stringify(b) }),
  deleteTool: (id: string) => req<void>(`/v1/tools/${id}`, { method: "DELETE" }),

  webhooks: () => req<Webhook[]>("/v1/webhooks"),
  createWebhook: (b: { url: string; events: string[] }) =>
    req<Webhook & { secret: string }>("/v1/webhooks", { method: "POST", body: JSON.stringify(b) }),
  deleteWebhook: (id: string) => req<void>(`/v1/webhooks/${id}`, { method: "DELETE" }),

  numbers: () => req<PhoneNumber[]>("/v1/phone-numbers"),
  createNumber: (b: { e164: string; agent_id: string }) =>
    req<PhoneNumber>("/v1/phone-numbers", { method: "POST", body: JSON.stringify(b) }),
  deleteNumber: (id: string) => req<void>(`/v1/phone-numbers/${id}`, { method: "DELETE" }),
};
