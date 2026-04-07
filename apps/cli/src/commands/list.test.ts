/**
 * Tests for `assignee list` command.
 *
 * @see Story 18.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the list-resources service
vi.mock("../services/list-resources.js", () => ({
  fetchManagedResources: vi.fn(),
}));

// Mock display utilities
vi.mock("../utils/display.js", () => ({
  renderResourceTable: vi.fn(),
  renderEmptyList: vi.fn(),
  renderError: vi.fn(),
}));

// Spies must be re-installed per test (vitest config has restoreMocks: true,
// which restores originals between tests). Previously these were defined at
// module top-level and silently relied on the leak.

let mockExit: any;

let stdoutWrite: any;

import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderResourceTable,
  renderEmptyList,
  renderError,
} from "../utils/display.js";
import type { ManagedResource } from "../services/list-resources.js";

const MOCK_RESOURCES: ManagedResource[] = [
  {
    resourceType: "AWS::S3::Bucket",
    arn: "arn:aws:s3:::my-bucket",
    region: "us-east-1",
    createdDate: "run-123",
    estimatedMonthlyCost: "N/A",
  },
  {
    resourceType: "AWS::Lambda::Function",
    arn: "arn:aws:lambda:us-east-1:123456789:function:my-fn",
    region: "us-east-1",
    createdDate: "run-456",
    estimatedMonthlyCost: "$0.20",
  },
];

async function runListCommand(args: string[] = []): Promise<void> {
  const { listCommand } = await import("./list.js");
  await listCommand.parseAsync(["node", "list", ...args]);
}

describe("assignee list command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  it("calls renderResourceTable when resources are found", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand();

    expect(renderResourceTable).toHaveBeenCalledWith(MOCK_RESOURCES);
    // Command completes without throwing (process.exit removed)
  });

  it("--json flag outputs valid JSON to stdout", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand(["--json"]);

    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"resourceType"'),
    );

    // Verify valid JSON was written
    const writtenData = vi.mocked(stdoutWrite).mock.calls[0]![0] as string;
    const parsed = JSON.parse(writtenData);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].arn).toBe("arn:aws:s3:::my-bucket");
    // Command completes without throwing (process.exit removed)
  });

  it("empty result shows helpful message", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await runListCommand();

    expect(renderEmptyList).toHaveBeenCalled();
    expect(renderResourceTable).not.toHaveBeenCalled();
    // Command completes without throwing (process.exit removed)
  });

  it("--region is forwarded to the service", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await runListCommand(["--region", "eu-west-1"]);

    expect(fetchManagedResources).toHaveBeenCalledWith("eu-west-1");
  });

  it("renders error on AccessDeniedException", async () => {
    const error = new Error("Access Denied");
    (error as unknown as { name: string }).name = "AccessDeniedException";
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("Access Denied");

    expect(renderError).toHaveBeenCalledWith(
      "Cannot list managed resources.",
      expect.stringContaining("ResourceGroupsTaggingAPI:GetResources"),
      expect.objectContaining({
        why: expect.stringContaining("tag:GetResources"),
      }),
    );
  });

  it("renders error on network failure", async () => {
    const error = new Error("getaddrinfo ENOTFOUND");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("getaddrinfo ENOTFOUND");

    expect(renderError).toHaveBeenCalledWith(
      "Failed to connect to AWS.",
      expect.stringContaining("internet connection"),
    );
  });

  it("renders generic error for unknown failures", async () => {
    const error = new Error("Something went wrong");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("Something went wrong");

    expect(renderError).toHaveBeenCalledWith(
      "Failed to list managed resources.",
      expect.stringContaining("AWS credentials"),
      expect.objectContaining({ why: "Something went wrong" }),
    );
  });
});
