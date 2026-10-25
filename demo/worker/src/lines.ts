// Call slots behind the Gate: how many calls run at once, how many seconds the demo may
// use today, and each visitor's daily calls. Plain logic over a SQL handle, like Quotas.

import { Quotas, type Sql } from "./quotas";

export interface CallLimits {
  perVisitor: number; // calls per visitor per day
  concurrent: number; // calls at once, site-wide
  dailySeconds: number; // talk time per day, site-wide
  maxSeconds: number; // one call's length
  connectSeconds: number; // how long a session may wait for the voice server to claim it
}

export type Start =
  | { ok: true; callsLeft: number }
  | { ok: false; reason: "limit_reached" | "lines_busy" | "paused" };

/** Extra time a claimed call may run past maxSeconds before its slot is reclaimed anyway. */
const GRACE_SECONDS = 60;

export class Lines {
  /**
   * Creates the tables if needed.
   * Args: sql — the storage handle; quotas — per-visitor counters (kind "call").
   */
  constructor(private sql: Sql, private quotas: Quotas) {
    sql.exec(`CREATE TABLE IF NOT EXISTS slots (
      session_id TEXT PRIMARY KEY, keys TEXT NOT NULL, day TEXT NOT NULL,
      created_at INTEGER NOT NULL, claimed_at INTEGER)`);
    sql.exec("CREATE TABLE IF NOT EXISTS seconds (day TEXT PRIMARY KEY, used INTEGER NOT NULL)");
  }

  /**
   * Reserves a line for a new session: the site-wide minute cap, then a free line,
   * then the visitor's daily calls. A full call length is reserved until it ends.
   * Args: sessionId — the new session; keys — the visitor's keys; day — UTC "YYYY-MM-DD";
   *   now — unix ms; limits — the current limits.
   * Returns: ok with the visitor's calls left, or the reason it can't start.
   */
  start(sessionId: string, keys: string[], day: string, now: number, limits: CallLimits): Start {
    this.sweep(now, limits);
    if (this.secondsUsed(day) + limits.maxSeconds > limits.dailySeconds) return { ok: false, reason: "paused" };
    if (this.active() >= limits.concurrent) return { ok: false, reason: "lines_busy" };
    const taken = this.quotas.take("call", keys, limits.perVisitor, day);
    if (!taken.ok) return { ok: false, reason: "limit_reached" };
    this.sql.exec(
      "INSERT INTO slots (session_id, keys, day, created_at) VALUES (?, ?, ?, ?)",
      sessionId, JSON.stringify(keys), day, now,
    );
    this.addSeconds(day, limits.maxSeconds);
    return { ok: true, callsLeft: taken.left };
  }

  /**
   * Marks a session's line as connected. Succeeds once per session, and only while
   * the session is still waiting, so a replayed or late ticket gets nothing.
   * Args: sessionId — the session; now — unix ms; limits — the current limits.
   * Returns: true the first time, false after that or if the slot is gone.
   */
  claim(sessionId: string, now: number, limits: CallLimits): boolean {
    this.sweep(now, limits);
    const row = this.slot(sessionId);
    if (!row || row.claimed_at !== null) return false;
    this.sql.exec("UPDATE slots SET claimed_at = ? WHERE session_id = ?", now, sessionId);
    return true;
  }

  /**
   * Frees a finished call's line and charges only the seconds it actually used.
   * Args: sessionId — the session; durationSeconds — how long it ran; limits — the current limits.
   * Returns: true if the session held a claimed line, false otherwise.
   */
  finish(sessionId: string, durationSeconds: number, limits: CallLimits): boolean {
    const row = this.slot(sessionId);
    if (!row || row.claimed_at === null) return false;
    this.sql.exec("DELETE FROM slots WHERE session_id = ?", sessionId);
    const used = Math.min(Math.max(0, Math.ceil(durationSeconds)), limits.maxSeconds);
    this.addSeconds(row.day, used - limits.maxSeconds);
    return true;
  }

  /**
   * Args: day — UTC "YYYY-MM-DD"; now — unix ms; limits — the current limits.
   * Returns: whether every line is taken, and whether today's minutes are used up.
   */
  status(day: string, now: number, limits: CallLimits): { busy: boolean; paused: boolean } {
    this.sweep(now, limits);
    return {
      busy: this.active() >= limits.concurrent,
      paused: this.secondsUsed(day) + limits.maxSeconds > limits.dailySeconds,
    };
  }

  /**
   * Releases lines that were never claimed (giving back the visitor's call and the
   * reserved time), and lines whose call ran far past its limit (keeping the time,
   * since the call may really have used it). Also drops earlier days' totals.
   * Args: now — unix ms; limits — the current limits.
   */
  sweep(now: number, limits: CallLimits): void {
    const stale = this.sql
      .exec("SELECT session_id, keys, day FROM slots WHERE claimed_at IS NULL AND created_at < ?", now - limits.connectSeconds * 1000)
      .toArray();
    for (const r of stale) {
      this.sql.exec("DELETE FROM slots WHERE session_id = ?", String(r.session_id));
      this.quotas.refund("call", JSON.parse(String(r.keys)), String(r.day));
      this.addSeconds(String(r.day), -limits.maxSeconds);
    }
    this.sql.exec(
      "DELETE FROM slots WHERE claimed_at IS NOT NULL AND claimed_at < ?",
      now - (limits.maxSeconds + GRACE_SECONDS) * 1000,
    );
    const today = new Date(now).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM seconds WHERE day < ?", today);
  }

  /** Returns the number of lines in use (waiting or connected). */
  private active(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM slots").toArray()[0].n);
  }

  /** Returns the session's slot row, or undefined. */
  private slot(sessionId: string): { day: string; claimed_at: number | null } | undefined {
    const r = this.sql.exec("SELECT day, claimed_at FROM slots WHERE session_id = ?", sessionId).toArray()[0];
    return r ? { day: String(r.day), claimed_at: r.claimed_at === null ? null : Number(r.claimed_at) } : undefined;
  }

  /** Returns the seconds reserved or used on `day`. */
  private secondsUsed(day: string): number {
    return Number(this.sql.exec("SELECT used FROM seconds WHERE day = ?", day).toArray()[0]?.used ?? 0);
  }

  /** Adds `delta` (may be negative) to `day`'s seconds, never going below zero. */
  private addSeconds(day: string, delta: number): void {
    const used = Math.max(0, this.secondsUsed(day) + delta);
    this.sql.exec(
      "INSERT INTO seconds (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = excluded.used",
      day, used,
    );
  }
}
