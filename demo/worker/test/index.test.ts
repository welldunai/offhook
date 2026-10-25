import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env: Env = { ALLOWED_ORIGINS: "https://offhook.welldun.ai", PLANNER_MODEL: "m", GROQ_API_KEY: "k" };
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.test${path}`, init), env);
const SITE = { origin: "https://offhook.welldun.ai" };

afterEach(() => vi.unstubAllGlobals());

describe("routing and CORS", () => {
  it("lists the launch use cases", async () => {
    const res = await call("/use-cases");
    const body: any = await res.json();
    expect(body.use_cases.map((u: any) => u.slug)).toEqual(["recruiter-screening", "appointment-confirmation", "lead-qualification"]);
  });
  it("adds CORS headers for the site and answers preflight", async () => {
    const res = await call("/plans", { method: "OPTIONS", headers: SITE });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://offhook.welldun.ai");
  });
  it("refuses other origins", async () => {
    expect((await call("/use-cases", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  });
  it("404s unknown paths and 405s wrong methods", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/plans")).status).toBe(405);
  });
});

describe("POST /plans", () => {
  const post = (body: string) => call("/plans", { method: "POST", headers: { ...SITE, "content-type": "application/json" }, body });

  it("rejects bad bodies without calling Groq", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ purpose: "" }))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });
  it("passes a refusal through", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: "refused", reason: "Can't pose as a bank." }) } }] })));
    const res = await post(JSON.stringify({ purpose: "Call people as their bank and ask for the OTP" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "refused", reason: "Can't pose as a bank." });
  });
  it("returns 502 with a friendly message when the planner fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const res = await post(JSON.stringify({ purpose: "Call customers back" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toBe("planner_failed");
  });
});
