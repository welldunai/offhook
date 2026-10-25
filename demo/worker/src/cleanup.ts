import { callLimits, CONNECT_SECONDS, gateOf, type Env } from "./config";

/**
 * The hourly cron: deletes sessions older than a day, marks sessions that never
 * connected as expired, and lets the Gate free stale lines.
 * Args: env — bindings; now — unix ms.
 */
export async function cleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM demo_sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("UPDATE demo_sessions SET status = 'expired' WHERE status = 'created' AND created_at < ?").bind(now - CONNECT_SECONDS * 1000),
  ]);
  await gateOf(env).sweep(now, callLimits(env));
}
