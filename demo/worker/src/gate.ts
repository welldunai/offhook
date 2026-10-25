// The Gate: one Durable Object instance that owns every demo limit. Requests to it run
// one at a time, so two tabs can't both take the last call of the day.
import { DurableObject } from "cloudflare:workers";
import { Lines, type CallLimits, type Start } from "./lines";
import { Quotas, type Take } from "./quotas";

export class Gate extends DurableObject<object> {
  private quotas: Quotas;
  private lines: Lines;

  /**
   * Args: ctx — the object's state and storage; env — the Worker's bindings (unused).
   */
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.quotas = new Quotas(ctx.storage.sql);
    this.lines = new Lines(ctx.storage.sql, this.quotas);
  }

  /** See Quotas.take. */
  take(kind: string, keys: string[], limit: number, day: string): Take {
    return this.quotas.take(kind, keys, limit, day);
  }

  /** See Quotas.refund. */
  refund(kind: string, keys: string[], day: string): void {
    this.quotas.refund(kind, keys, day);
  }

  /** See Lines.start. */
  startCall(sessionId: string, keys: string[], day: string, now: number, limits: CallLimits): Start {
    return this.lines.start(sessionId, keys, day, now, limits);
  }

  /** See Lines.claim. */
  claimCall(sessionId: string, now: number, limits: CallLimits): boolean {
    return this.lines.claim(sessionId, now, limits);
  }

  /** See Lines.finish. */
  finishCall(sessionId: string, durationSeconds: number, limits: CallLimits): boolean {
    return this.lines.finish(sessionId, durationSeconds, limits);
  }

  /** See Lines.status. */
  lineStatus(day: string, now: number, limits: CallLimits): { busy: boolean; paused: boolean } {
    return this.lines.status(day, now, limits);
  }

  /** See Lines.sweep. */
  sweep(now: number, limits: CallLimits): void {
    this.lines.sweep(now, limits);
  }
}
