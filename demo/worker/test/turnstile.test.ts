import { describe, expect, it } from "vitest";
import { verifyTurnstile } from "../src/turnstile";

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("verifyTurnstile", () => {
  it("accepts what Cloudflare accepts, and sends the secret, token and IP", async () => {
    let form: FormData | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ success: true }));
    }) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "sec", "203.0.113.7", f)).toBe(true);
    expect([form!.get("secret"), form!.get("response"), form!.get("remoteip")]).toEqual(["sec", "tok", "203.0.113.7"]);
  });
  it("rejects missing tokens without calling Cloudflare", async () => {
    const f = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    expect(await verifyTurnstile(undefined, "sec", null, f)).toBe(false);
    expect(await verifyTurnstile("", "sec", null, f)).toBe(false);
  });
  it("treats refusals, HTTP errors and network failures as failed", async () => {
    expect(await verifyTurnstile("tok", "sec", null, answer({ success: false }))).toBe(false);
    expect(await verifyTurnstile("tok", "sec", null, answer({}, 500))).toBe(false);
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await verifyTurnstile("tok", "sec", null, down)).toBe(false);
  });
});
