// Daily counters behind the Gate. Plain logic over a SQL handle, so it runs inside the
// Durable Object (ctx.storage.sql) and in tests (node:sqlite) unchanged.

/** The slice of Durable Object SqlStorage this module uses. */
export interface Sql {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}

export type Take = { ok: true; left: number } | { ok: false; left: 0 };

export class Quotas {
  /**
   * Creates the usage table if needed.
   * Args: sql — the storage handle.
   */
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY (day, kind, key))`);
  }

  /**
   * Uses one of today's `limit` for every key, or none if any key is used up.
   * A visitor has several keys (IP and cookie); whichever is used up first counts.
   * Args: kind — what is counted ("plan", "call"); keys — the visitor's keys;
   *   limit — allowed per day; day — "YYYY-MM-DD" in UTC.
   * Returns: ok with how many are left after this one, or not ok.
   */
  take(kind: string, keys: string[], limit: number, day: string): Take {
    this.sql.exec("DELETE FROM usage WHERE day < ?", day);
    const used = this.used(kind, keys, day);
    if (used >= limit) return { ok: false, left: 0 };
    for (const key of keys) {
      this.sql.exec(
        `INSERT INTO usage (day, kind, key, used) VALUES (?, ?, ?, 1)
         ON CONFLICT (day, kind, key) DO UPDATE SET used = used + 1`,
        day, kind, key,
      );
    }
    return { ok: true, left: limit - used - 1 };
  }

  /**
   * Gives back one use, when the thing it paid for failed on our side.
   * Args: kind, keys, day — as passed to take().
   */
  refund(kind: string, keys: string[], day: string): void {
    for (const key of keys) {
      this.sql.exec("UPDATE usage SET used = used - 1 WHERE day = ? AND kind = ? AND key = ? AND used > 0", day, kind, key);
    }
  }

  /**
   * Args: kind, keys, day — as for take().
   * Returns: the highest count among the keys today.
   */
  used(kind: string, keys: string[], day: string): number {
    let max = 0;
    for (const key of keys) {
      const row = this.sql.exec("SELECT used FROM usage WHERE day = ? AND kind = ? AND key = ?", day, kind, key).toArray()[0];
      max = Math.max(max, Number(row?.used ?? 0));
    }
    return max;
  }
}
