/** Stand-in for workerd's DurableObject base class in Node tests. */
export class DurableObject {
  constructor(public ctx: unknown, public env: unknown) {}
}
