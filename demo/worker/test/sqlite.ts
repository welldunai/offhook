import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../src/quotas";

/** An in-memory node:sqlite database shaped like Durable Object SqlStorage. */
export function memorySql(): Sql {
  const db = new DatabaseSync(":memory:");
  return { exec: (query, ...bindings) => { const rows = db.prepare(query).all(...bindings); return { toArray: () => rows as Record<string, unknown>[] }; } };
}
