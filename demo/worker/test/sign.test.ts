import { describe, expect, it } from "vitest";
import { makeTicket, readTicket, signRequest, verifyRequest } from "../src/sign";

const T0 = Date.parse("2026-10-25T12:00:00Z");

describe("tickets", () => {
  it("round-trips within a minute, then expires", async () => {
    const t = await makeTicket("k", "sid-1", T0);
    expect(await readTicket("k", t, T0 + 59_000)).toBe("sid-1");
    expect(await readTicket("k", t, T0 + 61_000)).toBeNull();
  });
  it("rejects other secrets, tampering and junk", async () => {
    const t = await makeTicket("k", "sid-1", T0);
    expect(await readTicket("other", t, T0)).toBeNull();
    const [p, s] = t.split(".");
    const forged = btoa(JSON.stringify({ sid: "sid-2", exp: 9e9 })).replace(/=+$/, "");
    expect(await readTicket("k", `${forged}.${s}`, T0)).toBeNull();
    expect(await readTicket("k", `${p}.${"0".repeat(64)}`, T0)).toBeNull();
    for (const junk of [undefined, "", "a.b.c", p, 42]) expect(await readTicket("k", junk, T0)).toBeNull();
  });
});

describe("signed requests", () => {
  it("verifies the exact body within the clock skew", async () => {
    const body = JSON.stringify({ ticket: "x" });
    const h = new Headers(await signRequest("k", body, T0));
    expect(await verifyRequest("k", h, body, T0 + 30_000)).toBe(true);
    expect(await verifyRequest("k", h, body + " ", T0)).toBe(false);
    expect(await verifyRequest("other", h, body, T0)).toBe(false);
    expect(await verifyRequest("k", h, body, T0 + 61_000)).toBe(false);
    expect(await verifyRequest("k", new Headers(), body, T0)).toBe(false);
  });
});

// Pinned vectors: tests/demo/test_signing.py asserts the same strings, so the
// Worker and the Python voice server can't drift apart.
describe("matches the voice server (app/demo/signing.py)", () => {
  const SID = "3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b";
  const TICKET =
    "eyJzaWQiOiIzYjJlNmYxYy04YTRkLTRhOGUtOWYwYi0xYzJkM2U0ZjVhNmIiLCJleHAiOjE3OTIwMDAwMDB9.6efc2c59eac016165f4888e68b05f6c2d92752532014417a0ff327c47b631489";
  it("makes the same ticket", async () => {
    expect(await makeTicket("test-secret", SID, 1_791_999_940_000)).toBe(TICKET);
    expect(await readTicket("test-secret", TICKET, 1_791_999_999_000)).toBe(SID);
  });
  it("signs requests the same way", async () => {
    expect(await signRequest("test-secret", '{"ticket":"abc"}', 1_792_000_000_000)).toEqual({
      "x-offhook-timestamp": "1792000000",
      "x-offhook-signature": "2cf36802ad16235bf86a3968b350a84f5f3303a587f1c605d55fcfd22f3a26e8",
    });
  });
});
