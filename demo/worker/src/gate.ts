// The Gate: one Durable Object instance that owns every demo limit. Requests to it run
// one at a time, so two tabs can't both take the last call of the day.
// Step 2b: per-visitor daily quotas. Call slots and the minute cap arrive with sessions.
import { DurableObject } from "cloudflare:workers";
import { Quotas, type Take } from "./quotas";

export class Gate extends DurableObject<object> {
  private quotas: Quotas;

  /**
   * Args: ctx — the object's state and storage; env — the Worker's bindings.
   */
  constructor(ctx: DurableObjectState, env: object) {
    super(ctx, env);
    this.quotas = new Quotas(ctx.storage.sql);
  }

  /** See Quotas.take. */
  take(kind: string, keys: string[], limit: number, day: string): Take {
    return this.quotas.take(kind, keys, limit, day);
  }

  /** See Quotas.refund. */
  refund(kind: string, keys: string[], day: string): void {
    this.quotas.refund(kind, keys, day);
  }
}
