import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { api } from "../api";
import Calls from "./Calls";

vi.mock("../api", () => ({
  api: { calls: vi.fn(), agents: vi.fn(async () => []), createCall: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

const mockCalls = api.calls as unknown as ReturnType<typeof vi.fn>;

function row(id: string, tags: Record<string, string>) {
  return {
    id, status: "completed", direction: "outbound", to_number: "+14155550001",
    from_number: null, provider_call_id: null, error_code: null, duration_seconds: 30,
    tags, created_at: "2026-06-30T10:00:00Z", started_at: null, ended_at: null,
  };
}

const SAMPLE = [row("1111aaaa-1111-1111-1111-111111111111", { region: "North", motive: "sales" })];

const renderCalls = () => render(<MemoryRouter><Calls /></MemoryRouter>);
const lastArgs = () => mockCalls.mock.calls.at(-1)![0];

beforeEach(() => {
  mockCalls.mockReset();
  mockCalls.mockResolvedValue(SAMPLE);
});

describe("Calls page", () => {
  it("renders rows with tag chips", async () => {
    renderCalls();
    expect(await screen.findByTitle("Filter by region:North")).toBeInTheDocument();
    expect(screen.getByTitle("Filter by motive:sales")).toBeInTheDocument();
  });

  it("fetches the first page with no tag filter initially", async () => {
    renderCalls();
    await waitFor(() => expect(mockCalls).toHaveBeenCalled());
    expect(lastArgs()).toMatchObject({ limit: 10, offset: 0 });
    expect(lastArgs().tags).toBeUndefined();
  });

  it("adds a tag filter via the input and refetches with tags", async () => {
    renderCalls();
    await screen.findByTitle("Filter by region:North");
    const input = screen.getByPlaceholderText("Tag, e.g. region:North");
    await userEvent.type(input, "region:North{Enter}");
    await waitFor(() => expect(lastArgs().tags).toEqual(["region:North"]));
    expect(screen.getByText("Filtering by")).toBeInTheDocument();
  });

  it("adds a tag filter by clicking a row chip", async () => {
    renderCalls();
    const chip = await screen.findByTitle("Filter by motive:sales");
    await userEvent.click(chip);
    await waitFor(() => expect(lastArgs().tags).toEqual(["motive:sales"]));
  });

  it("removes a tag filter and refetches without it", async () => {
    renderCalls();
    const input = await screen.findByPlaceholderText("Tag, e.g. region:North");
    await userEvent.type(input, "region:North{Enter}");
    await waitFor(() => expect(lastArgs().tags).toEqual(["region:North"]));
    await userEvent.click(screen.getByLabelText("Remove filter region:North"));
    await waitFor(() => expect(lastArgs().tags).toBeUndefined());
  });

  it("filters by status via the dropdown", async () => {
    renderCalls();
    await screen.findByTitle("Filter by region:North");
    await userEvent.click(screen.getByRole("button", { name: /all statuses/i }));
    await userEvent.click(screen.getByRole("option", { name: "Failed" }));
    await waitFor(() => expect(lastArgs()).toMatchObject({ status: "failed" }));
  });

  it("paginates to the next page", async () => {
    // a full page (PAGE_SIZE=10) enables Next
    mockCalls.mockResolvedValue(Array.from({ length: 10 }, (_, i) =>
      row(`${i}000aaaa-1111-1111-1111-111111111111`, {})));
    renderCalls();
    await waitFor(() => expect(mockCalls).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(lastArgs()).toMatchObject({ offset: 10 }));
  });
});
