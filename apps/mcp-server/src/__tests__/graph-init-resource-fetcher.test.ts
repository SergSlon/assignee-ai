/**
 * BLOCKER 2 regression test — MCP graph-init resourceFetcher wiring.
 *
 * Without the fix, createGraphContext() called createGraph() with no options,
 * so `options.resourceFetcher` was undefined. Every MCP query intent then hit
 * `if (!resourceFetcher)` in query-handler.ts and returned "not available in
 * this context" instead of resolving live AWS resources.
 *
 * This test asserts that createGraph() receives a non-null `resourceFetcher`
 * when called from createGraphContext(), by verifying the option is forwarded
 * from the MCP-side fetchManagedResources service.
 *
 * Story: feature-query-intent-classifier (BLOCKER 2 fix)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted must be called BEFORE vi.mock factories so the variables are
// available in the hoisted factory closures (vitest requirement).
const { mockCreateGraph, mockFetchManagedResources } = vi.hoisted(() => ({
  mockCreateGraph: vi
    .fn()
    .mockReturnValue({ invoke: vi.fn(), getState: vi.fn() }),
  mockFetchManagedResources: vi.fn().mockResolvedValue([]),
}));

// ── Mock createGraph from @assignee/core/graph ───────────────────────────────
vi.mock("@assignee/core/graph", () => ({
  createGraph: mockCreateGraph,
}));

// ── Mock fetchManagedResources from list-resources.ts ────────────────────────
vi.mock("../services/list-resources.js", () => ({
  fetchManagedResources: mockFetchManagedResources,
  resolveDefaultRegion: () => "us-east-1",
}));

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { createGraphContext } from "../services/graph-init.js";

describe("createGraphContext — BLOCKER 2 resourceFetcher wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGraph.mockReturnValue({ invoke: vi.fn(), getState: vi.fn() });
    mockFetchManagedResources.mockResolvedValue([]);
  });

  it("passes a non-null resourceFetcher to createGraph", async () => {
    await createGraphContext();

    expect(mockCreateGraph).toHaveBeenCalledOnce();
    const [, options] = mockCreateGraph.mock.calls[0]!;
    expect(options).toBeDefined();
    expect(typeof options.resourceFetcher).toBe("function");
  });

  it("resourceFetcher delegates to fetchManagedResources from list-resources", async () => {
    await createGraphContext();

    const [, options] = mockCreateGraph.mock.calls[0]!;
    const fetcher = options.resourceFetcher as (
      resourceType?: string,
    ) => Promise<unknown[]>;

    // Call the injected fetcher and verify it delegates to the real service.
    await fetcher("AWS::S3::Bucket");
    expect(mockFetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::S3::Bucket",
    );
  });

  it("resourceFetcher passes undefined region (resolveDefaultRegion used internally)", async () => {
    await createGraphContext();

    const [, options] = mockCreateGraph.mock.calls[0]!;
    const fetcher = options.resourceFetcher as (
      resourceType?: string,
    ) => Promise<unknown[]>;

    await fetcher();
    expect(mockFetchManagedResources).toHaveBeenCalledWith(
      undefined,
      undefined,
    );
  });
});
