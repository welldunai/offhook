// The planner: turns a plain-English purpose into a call plan, or refuses it.
// One request to Groq for JSON, then strict validation, so nothing the model
// invents reaches the voice server unchecked.

export const MAX_PURPOSE = 500;
export const MAX_FIELDS = 5;
export const MAX_ASSUMPTIONS = 6;

/** What the visitor sees and edits before a call; the voice server runs it as-is. */
export interface Plan {
  agent: { name: string; company: string; role: string };
  person: string; // who the visitor plays
  brief: string; // what the visitor is told before the call
  goal: string;
  firstMessage: string;
  instructions: string;
  assumptions: Record<string, string>; // facts made up for this call, shown as such
  fields: { key: string; label: string }[];
}

export type PlanResult =
  | { status: "planned"; plan: Plan }
  | { status: "refused"; reason: string };

/** Thrown when the model's answer can't be used; the route maps it to 502. */
export class PlannerError extends Error {}

const LIMITS = {
  name: 40, company: 60, role: 60, person: 60, brief: 400, goal: 300,
  firstMessage: 300, instructions: 1500, assumptionKey: 40, assumptionValue: 200,
  fieldLabel: 40, reason: 200,
};
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const SYSTEM_PROMPT = `You plan short outbound phone calls for a demo of Offhook, an AI calling agent.
The visitor describes what a call is for. In the demo, the visitor plays the person being called; nobody else is ever called.

Reply with JSON only, in one of two shapes.

If the purpose is fine:
{"status":"planned","plan":{
  "agent":{"name":"first name","company":"company name","role":"job title"},
  "person":"who the visitor plays, e.g. 'the customer'",
  "brief":"2-3 sentences telling the visitor who they are and a realistic situation to act out. Address them as 'you'.",
  "goal":"one plain sentence: what the agent is trying to get done",
  "firstMessage":"the agent's opening line: greet, say who it is and why it's calling, ask if now is a good time",
  "instructions":"the agent's instructions, in second person: what to ask, in what order, one question at a time, what to do if the person says no, and to record each answer with record_result. Under 150 words.",
  "assumptions":{"short_key":"a fact the agent needs that the visitor didn't give, e.g. a date or an order number"},
  "fields":[{"key":"snake_case_key","label":"Short label"}]
}}

If the purpose must be refused:
{"status":"refused","reason":"one short, polite sentence saying why"}

Rules:
- Use the company the visitor names; otherwise make up a plausible fictional one. Never use a real bank, government body, delivery company or famous brand, and never pretend to be a real, named person.
- 1 to ${MAX_FIELDS} fields: the answers the call is for. Keys are lowercase snake_case.
- At most ${MAX_ASSUMPTIONS} assumptions, only facts the agent needs.
- Keep everything friendly, brief and natural for a phone call. Plain words, no markdown.
- Refuse purposes that are: scams or deception (impersonating a real organisation or person, fake prizes, fake debts); collecting passwords, one-time codes, card or bank numbers; harassment, threats or intimidation; political or election calls; illegal or sexual content; or anything that isn't a phone call a business or person would plausibly make.`;

/**
 * Checks a visitor's purpose before it costs a model call.
 * Args: raw — the request's `purpose` value, of any type.
 * Returns: the trimmed purpose, or an error message for the visitor.
 */
export function checkPurpose(raw: unknown): { purpose: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Describe the call first." };
  const purpose = raw.trim().replace(/\s+/g, " ");
  if (purpose.length > MAX_PURPOSE) return { error: `Keep it under ${MAX_PURPOSE} characters.` };
  return { purpose };
}

/**
 * Validates and normalises the model's answer, so the rest of the system can trust a Plan.
 * Args: data — the parsed JSON the model returned.
 * Returns: a PlanResult. Throws PlannerError if the shape or any limit is wrong.
 */
export function parsePlanResult(data: unknown): PlanResult {
  const o = obj(data, "answer");
  if (o.status === "refused") return { status: "refused", reason: text(o.reason, "reason", LIMITS.reason) };
  if (o.status !== "planned") throw new PlannerError("status must be planned or refused");

  const p = obj(o.plan, "plan");
  const agent = obj(p.agent, "agent");
  const fieldsRaw = p.fields;
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length < 1 || fieldsRaw.length > MAX_FIELDS) {
    throw new PlannerError(`fields must have 1 to ${MAX_FIELDS} entries`);
  }
  const fields = fieldsRaw.map((f, i) => {
    const fo = obj(f, `fields[${i}]`);
    const key = text(fo.key, `fields[${i}].key`, 40);
    if (!KEY.test(key)) throw new PlannerError(`fields[${i}].key must be snake_case`);
    return { key, label: text(fo.label, `fields[${i}].label`, LIMITS.fieldLabel) };
  });
  if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new PlannerError("field keys must be unique");

  const assumptionsRaw = p.assumptions === undefined ? {} : obj(p.assumptions, "assumptions");
  const entries = Object.entries(assumptionsRaw);
  if (entries.length > MAX_ASSUMPTIONS) throw new PlannerError(`at most ${MAX_ASSUMPTIONS} assumptions`);
  const assumptions: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length > LIMITS.assumptionKey) throw new PlannerError("assumption key too long");
    assumptions[k] = text(typeof v === "number" || typeof v === "boolean" ? String(v) : v, `assumptions.${k}`, LIMITS.assumptionValue);
  }

  return {
    status: "planned",
    plan: {
      agent: {
        name: text(agent.name, "agent.name", LIMITS.name),
        company: text(agent.company, "agent.company", LIMITS.company),
        role: text(agent.role, "agent.role", LIMITS.role),
      },
      person: text(p.person, "person", LIMITS.person),
      brief: text(p.brief, "brief", LIMITS.brief),
      goal: text(p.goal, "goal", LIMITS.goal),
      firstMessage: text(p.firstMessage, "firstMessage", LIMITS.firstMessage),
      instructions: text(p.instructions, "instructions", LIMITS.instructions),
      assumptions,
      fields,
    },
  };
}

/**
 * Asks Groq for a plan and validates it.
 * Args: purpose — a purpose already passed through checkPurpose; opts — API key, model,
 *   and an optional fetch (tests pass a fake).
 * Returns: a PlanResult. Throws PlannerError if Groq fails or answers badly.
 */
export async function planCall(
  purpose: string,
  opts: { apiKey: string; model: string; fetch?: typeof fetch },
): Promise<PlanResult> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0.4,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Purpose of the call:\n${purpose}` },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new PlannerError(`groq request failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new PlannerError(`groq returned ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new PlannerError("groq returned no content");
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new PlannerError("groq returned invalid JSON");
  }
  return parsePlanResult(data);
}

/** Returns `v` as an object, or throws PlannerError naming `where`. */
function obj(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PlannerError(`${where} must be an object`);
  return v as Record<string, unknown>;
}

/** Returns `v` trimmed, if it's a non-empty string within `max` characters; else throws PlannerError. */
function text(v: unknown, where: string, max: number): string {
  if (typeof v !== "string" || !v.trim()) throw new PlannerError(`${where} must be a non-empty string`);
  const t = v.trim();
  if (t.length > max) throw new PlannerError(`${where} is over ${max} characters`);
  return t;
}
