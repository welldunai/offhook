import { describe, expect, it } from "vitest";
import { checkPurpose, parsePlanResult, planCall, PlannerError } from "../src/plan";

const PLAN = {
  agent: { name: "Maya", company: "Parcelly", role: "customer care" },
  person: "the customer",
  brief: "Your parcel didn't arrive yesterday. You're home on Thursday.",
  goal: "Find a new delivery day and note instructions for the driver.",
  firstMessage: "Hi, this is Maya from Parcelly. Is now a good time?",
  instructions: "Ask which day works, then any instructions for the driver. Record each with record_result.",
  assumptions: { missed_date: "Monday 20 October" },
  fields: [{ key: "new_day", label: "New day" }, { key: "driver_notes", label: "Notes for the driver" }],
};

/** A fake fetch that answers like Groq with `content` (or a status code). */
function groq(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
}

describe("checkPurpose", () => {
  it("trims and collapses whitespace", () => {
    expect(checkPurpose("  call   people \n back ")).toEqual({ purpose: "call people back" });
  });
  it("rejects empty, non-string and over-long input", () => {
    expect(checkPurpose("   ")).toHaveProperty("error");
    expect(checkPurpose(42)).toHaveProperty("error");
    expect(checkPurpose("x".repeat(501))).toHaveProperty("error");
    expect(checkPurpose("x".repeat(500))).toEqual({ purpose: "x".repeat(500) });
  });
});

describe("parsePlanResult", () => {
  it("accepts a good plan", () => {
    expect(parsePlanResult({ status: "planned", plan: PLAN })).toEqual({ status: "planned", plan: PLAN });
  });
  it("accepts a refusal", () => {
    expect(parsePlanResult({ status: "refused", reason: "That's impersonating a bank." })).toEqual({
      status: "refused",
      reason: "That's impersonating a bank.",
    });
  });
  it("defaults missing assumptions and stringifies numbers", () => {
    const { assumptions, ...rest } = PLAN;
    expect(parsePlanResult({ status: "planned", plan: rest })).toMatchObject({ plan: { assumptions: {} } });
    expect(parsePlanResult({ status: "planned", plan: { ...PLAN, assumptions: { order: 1042 } } })).toMatchObject({
      plan: { assumptions: { order: "1042" } },
    });
  });
  it.each([
    ["unknown status", { status: "maybe" }],
    ["no fields", { status: "planned", plan: { ...PLAN, fields: [] } }],
    ["too many fields", { status: "planned", plan: { ...PLAN, fields: Array.from({ length: 6 }, (_, i) => ({ key: `f${i}`, label: "x" })) } }],
    ["bad key", { status: "planned", plan: { ...PLAN, fields: [{ key: "New Day", label: "x" }] } }],
    ["duplicate keys", { status: "planned", plan: { ...PLAN, fields: [{ key: "a", label: "x" }, { key: "a", label: "y" }] } }],
    ["long instructions", { status: "planned", plan: { ...PLAN, instructions: "x".repeat(1501) } }],
    ["missing agent name", { status: "planned", plan: { ...PLAN, agent: { ...PLAN.agent, name: "" } } }],
    ["too many assumptions", { status: "planned", plan: { ...PLAN, assumptions: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`a${i}`, "x"])) } }],
    ["refusal without reason", { status: "refused" }],
  ])("rejects %s", (_, data) => {
    expect(() => parsePlanResult(data)).toThrow(PlannerError);
  });
});

describe("planCall", () => {
  const opts = (f: typeof fetch) => ({ apiKey: "k", model: "m", fetch: f });
  it("returns the validated plan", async () => {
    const r = await planCall("call people", opts(groq(JSON.stringify({ status: "planned", plan: PLAN }))));
    expect(r.status).toBe("planned");
  });
  it("sends the purpose, model and JSON mode", async () => {
    let sent: any;
    const f = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: "refused", reason: "No." }) } }] }));
    }) as unknown as typeof fetch;
    await planCall("call my landlord", opts(f));
    expect(sent.model).toBe("m");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages.at(-1).content).toContain("call my landlord");
  });
  it("throws PlannerError on HTTP errors, bad JSON and network failures", async () => {
    await expect(planCall("x", opts(groq("{}", 500)))).rejects.toThrow(PlannerError);
    await expect(planCall("x", opts(groq("not json")))).rejects.toThrow(PlannerError);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(planCall("x", opts(down))).rejects.toThrow(PlannerError);
  });
});
