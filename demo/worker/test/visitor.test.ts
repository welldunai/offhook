import { describe, expect, it } from "vitest";
import { COOKIE, identify, secondsToReset, utcDay } from "../src/visitor";

const req = (headers: Record<string, string>) => new Request("https://demo.test/plans", { headers });
const ID = "3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b";

describe("identify", () => {
  it("hashes the IP and cookie, never storing them raw", async () => {
    const v = await identify(req({ "cf-connecting-ip": "203.0.113.7", cookie: `${COOKIE}=${ID}` }), "salt", "2026-10-25");
    expect(v.setCookie).toBeUndefined();
    expect(v.keys).toHaveLength(2);
    expect(v.keys.join()).not.toContain("203.0.113.7");
    expect(v.keys.join()).not.toContain(ID);
    expect(v.keys[0]).toMatch(/^ip:[0-9a-f]{32}$/);
  });
  it("rotates keys daily and with the salt", async () => {
    const r = req({ "cf-connecting-ip": "203.0.113.7", cookie: `${COOKIE}=${ID}` });
    const a = await identify(r, "salt", "2026-10-25");
    expect((await identify(r, "salt", "2026-10-25")).keys).toEqual(a.keys);
    expect((await identify(r, "salt", "2026-10-26")).keys[0]).not.toBe(a.keys[0]);
    expect((await identify(r, "other", "2026-10-25")).keys[0]).not.toBe(a.keys[0]);
  });
  it("sets a fresh cookie when it's missing or malformed", async () => {
    for (const cookie of ["", `${COOKIE}=nonsense`, "other=1"]) {
      const v = await identify(req({ cookie }), "salt", "2026-10-25");
      expect(v.setCookie).toMatch(new RegExp(`^${COOKIE}=[0-9a-f-]{36}; .*HttpOnly; Secure; SameSite=Lax`));
    }
  });
});

describe("days", () => {
  it("uses UTC dates and counts down to UTC midnight", () => {
    const t = new Date("2026-10-25T23:59:30Z");
    expect(utcDay(t)).toBe("2026-10-25");
    expect(secondsToReset(t)).toBe(30);
  });
});
