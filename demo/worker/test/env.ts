import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/config";
import { Gate } from "../src/gate";
import { memorySql } from "./sqlite";

type Bind = string | number | null;

/** A D1Database stand-in over in-memory node:sqlite, with the real migrations applied. */
export function memoryD1(): { d1: D1Database; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const statement = (sql: string, binds: Bind[] = []) => ({
    bind: (...b: Bind[]) => statement(sql, b),
    run: async () => { db.prepare(sql).run(...binds); return { success: true }; },
    first: async () => db.prepare(sql).get(...binds) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...binds) }),
  });
  const d1 = {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
  };
  return { d1: d1 as unknown as D1Database, db };
}

/**
 * A full Env for tests: the real Gate class over node:sqlite, D1 over node:sqlite,
 * and small limits so tests reach them quickly.
 * Args: overrides — vars to change.
 * Returns: the env and the raw session database for assertions.
 */
export function testEnv(overrides: Partial<Env> = {}): { env: Env; db: DatabaseSync } {
  const gate = new Gate({ storage: { sql: memorySql() } } as unknown as DurableObjectState, {});
  const { d1, db } = memoryD1();
  const env: Env = {
    ALLOWED_ORIGINS: "https://offhook.welldun.ai",
    PLANNER_MODEL: "m",
    VOICE_URL: "http://voice.test",
    DAILY_PLANS_PER_VISITOR: "2",
    DAILY_CALLS_PER_VISITOR: "2",
    MAX_CALL_SECONDS: "120",
    MAX_CONCURRENT: "5",
    DAILY_MINUTES_CAP: "300",
    GROQ_API_KEY: "k",
    TURNSTILE_SECRET_KEY: "t",
    VISITOR_HASH_SALT: "s",
    DEMO_HMAC_SECRET: "secret",
    GATE: { idFromName: () => "gate", get: () => gate } as unknown as Env["GATE"],
    DB: d1,
    ...overrides,
  };
  return { env, db };
}
