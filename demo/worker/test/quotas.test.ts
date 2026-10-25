import { describe, expect, it } from "vitest";
import { Quotas } from "../src/quotas";
import { memorySql } from "./sqlite";

const DAY = "2026-10-25";

describe("Quotas", () => {
  it("counts down to the limit, then refuses", () => {
    const q = new Quotas(memorySql());
    expect(q.take("plan", ["ip:a", "id:b"], 3, DAY)).toEqual({ ok: true, left: 2 });
    expect(q.take("plan", ["ip:a", "id:b"], 3, DAY)).toEqual({ ok: true, left: 1 });
    expect(q.take("plan", ["ip:a", "id:b"], 3, DAY)).toEqual({ ok: true, left: 0 });
    expect(q.take("plan", ["ip:a", "id:b"], 3, DAY)).toEqual({ ok: false, left: 0 });
  });
  it("uses whichever key is used up first: a new cookie on the same IP doesn't reset it", () => {
    const q = new Quotas(memorySql());
    q.take("plan", ["ip:a", "id:b"], 2, DAY);
    q.take("plan", ["ip:a", "id:b"], 2, DAY);
    expect(q.take("plan", ["ip:a", "id:new"], 2, DAY).ok).toBe(false);
    expect(q.take("plan", ["ip:other", "id:b"], 2, DAY).ok).toBe(false);
    expect(q.take("plan", ["ip:other", "id:new"], 2, DAY).ok).toBe(true);
  });
  it("keeps kinds apart and resets on a new day", () => {
    const q = new Quotas(memorySql());
    q.take("plan", ["ip:a"], 1, DAY);
    expect(q.take("call", ["ip:a"], 1, DAY).ok).toBe(true);
    expect(q.take("plan", ["ip:a"], 1, "2026-10-26").ok).toBe(true);
  });
  it("deletes earlier days' rows", () => {
    const sql = memorySql();
    const q = new Quotas(sql);
    q.take("plan", ["ip:a"], 5, "2026-10-24");
    q.take("plan", ["ip:a"], 5, DAY);
    expect(sql.exec("SELECT day FROM usage").toArray()).toEqual([{ day: DAY }]);
  });
  it("refunds one use, never below zero", () => {
    const q = new Quotas(memorySql());
    q.take("plan", ["ip:a"], 1, DAY);
    q.refund("plan", ["ip:a"], DAY);
    q.refund("plan", ["ip:a"], DAY);
    expect(q.used("plan", ["ip:a"], DAY)).toBe(0);
    expect(q.take("plan", ["ip:a"], 1, DAY).ok).toBe(true);
  });
});
