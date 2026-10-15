import { describe, it, expect, beforeEach, vi } from "vitest";
import { api, ApiError } from "./api";

function mockFetch(body: unknown, { ok = true, status = 200 } = {}) {
  const fn = vi.fn(async () => ({
    ok, status,
    json: async () => body,
  })) as unknown as typeof fetch;
  globalThis.fetch = fn;
  return fn as unknown as ReturnType<typeof vi.fn>;
}

function calledUrl(fn: ReturnType<typeof vi.fn>): string {
  return fn.mock.calls[0][0] as string;
}

describe("api.calls query building", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("builds no query string when no params", async () => {
    const fn = mockFetch([]);
    await api.calls();
    expect(calledUrl(fn)).toMatch(/\/v1\/calls$/);
  });

  it("encodes single-valued filters", async () => {
    const fn = mockFetch([]);
    await api.calls({ status: "failed", direction: "outbound", limit: 25, offset: 50 });
    const url = calledUrl(fn);
    expect(url).toContain("status=failed");
    expect(url).toContain("direction=outbound");
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=50");
  });

  it("emits a repeated tag param for each tag (AND search)", async () => {
    const fn = mockFetch([]);
    await api.calls({ tags: ["region:North", "motive:sales"] });
    const url = calledUrl(fn);
    expect(url).toContain("tag=region%3ANorth");
    expect(url).toContain("tag=motive%3Asales");
    // two separate tag params, not one joined value
    expect(url.match(/tag=/g)).toHaveLength(2);
  });

  it("omits empty/undefined params", async () => {
    const fn = mockFetch([]);
    await api.calls({ status: "", direction: undefined, tags: [] });
    expect(calledUrl(fn)).toMatch(/\/v1\/calls$/);
  });
});

describe("api.createCall", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts agent, number, and tags in the body", async () => {
    const fn = mockFetch({ id: "c1", status: "queued", direction: "outbound", provider_call_id: null });
    await api.createCall({
      agent_id: "a1", to_number: "+14155550123", tags: { region: "North" },
    });
    const opts = fn.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({ agent_id: "a1", to_number: "+14155550123", tags: { region: "North" } });
  });
});

describe("error handling", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("throws ApiError with the server detail on non-2xx", async () => {
    mockFetch({ detail: "concurrent call limit reached" }, { ok: false, status: 429 });
    await expect(api.calls()).rejects.toMatchObject({
      status: 429, message: "concurrent call limit reached",
    });
  });

  it("ApiError carries the status code", async () => {
    mockFetch({ detail: "nope" }, { ok: false, status: 404 });
    const err = await api.calls().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
  });
});
