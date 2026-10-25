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
