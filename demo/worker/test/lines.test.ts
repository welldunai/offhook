import { describe, expect, it } from "vitest";
import { Lines, type CallLimits } from "../src/lines";
import { Quotas } from "../src/quotas";
import { memorySql } from "./sqlite";

const DAY = "2026-10-25";
const T0 = Date.parse("2026-10-25T12:00:00Z");
const L: CallLimits = { perVisitor: 3, concurrent: 2, dailySeconds: 600, maxSeconds: 120, connectSeconds: 60 };
const make = () => {
  const quotas = new Quotas(memorySql());
  return { lines: new Lines(memorySql(), quotas), quotas };
};
// Lines and Quotas share one database in the Gate; give them one here too.
const shared = () => {
  const sql = memorySql();
  const quotas = new Quotas(sql);
  return { lines: new Lines(sql, quotas), quotas, sql };
};

describe("Lines", () => {
  it("starts calls until every line is busy", () => {
    const { lines } = make();
    expect(lines.start("s1", ["v1"], DAY, T0, L)).toEqual({ ok: true, callsLeft: 2 });
    expect(lines.start("s2", ["v2"], DAY, T0, L).ok).toBe(true);
    expect(lines.start("s3", ["v3"], DAY, T0, L)).toEqual({ ok: false, reason: "lines_busy" });
  });
  it("enforces the visitor's daily calls", () => {
    const { lines } = make();
    const big = { ...L, concurrent: 10, dailySeconds: 10_000 };
    for (const id of ["a", "b", "c"]) expect(lines.start(id, ["v"], DAY, T0, big).ok).toBe(true);
    expect(lines.start("d", ["v"], DAY, T0, big)).toEqual({ ok: false, reason: "limit_reached" });
  });
  it("pauses when the day's minutes are reserved, before touching the visitor's quota", () => {
    const { lines, quotas } = make();
    const small = { ...L, concurrent: 10, dailySeconds: 240 };
    lines.start("a", ["v1"], DAY, T0, small);
    lines.start("b", ["v2"], DAY, T0, small);
    expect(lines.start("c", ["v3"], DAY, T0, small)).toEqual({ ok: false, reason: "paused" });
    expect(quotas.used("call", ["v3"], DAY)).toBe(0);
  });
  it("claims once, and charges only the seconds used", () => {
    const { lines } = make();
    const small = { ...L, concurrent: 10, dailySeconds: 240 };
    lines.start("a", ["v1"], DAY, T0, small);
    lines.start("b", ["v2"], DAY, T0, small);
    expect(lines.claim("a", T0 + 1000, small)).toBe(true);
    expect(lines.claim("a", T0 + 2000, small)).toBe(false);
    expect(lines.finish("a", 30, small)).toBe(true);
    expect(lines.finish("a", 30, small)).toBe(false);
    // 30 + 120 reserved = 150 of 240: one more full call doesn't fit, so still paused...
    expect(lines.status(DAY, T0, small).paused).toBe(true);
    lines.claim("b", T0, small);
    lines.finish("b", 10, small);
    // ...but after b used only 10, 40 of 240 is used and calls fit again.
    expect(lines.status(DAY, T0, small)).toEqual({ busy: false, paused: false });
  });
  it("can't finish a session that was never claimed", () => {
    const { lines } = make();
    lines.start("a", ["v"], DAY, T0, L);
    expect(lines.finish("a", 10, L)).toBe(false);
  });
  it("frees unclaimed lines after the connect window and gives the call back", () => {
    const { lines, quotas } = shared();
    lines.start("a", ["v"], DAY, T0, L);
    lines.start("b", ["w"], DAY, T0, L);
    expect(lines.claim("a", T0 + 61_000, L)).toBe(false); // swept first: too late
    expect(quotas.used("call", ["v"], DAY)).toBe(0);
    expect(lines.status(DAY, T0 + 61_000, L).busy).toBe(false);
  });
  it("reclaims a connected line long past its limit, keeping the time charged", () => {
    const { lines } = make();
    const one = { ...L, concurrent: 1 };
    lines.start("a", ["v"], DAY, T0, one);
    lines.claim("a", T0, one);
    expect(lines.start("b", ["w"], DAY, T0 + 100_000, one)).toEqual({ ok: false, reason: "lines_busy" });
    expect(lines.start("b", ["w"], DAY, T0 + 181_000, one).ok).toBe(true);
  });
});
