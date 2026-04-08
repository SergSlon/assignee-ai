/**
 * Tests for `assignee list` command.
 *
 * @see Story 18.4
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockInstance,
} from "vitest";

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

// process.stdout.write is an overloaded function; use the exact signature
// so TS accepts the spy return type on assignment.
let stdoutWrite: MockInstance<typeof process.stdout.write>;

import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderResourceTable,
  renderEmptyList,
  renderError,
} from "../utils/display.js";
import type { ManagedResource } from "../services/list-resources.js";
import { parseMonthlyCost } from "./list.js";

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
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
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

  // A3 / optimize follow-up (2026-04-08): the --total-cost flag uses
  // parseMonthlyCost() to coerce the four cost-string shapes the list
  // service emits into a single USD monthly number. The fn is exported
  // precisely so we can lock the coercion rules in a unit test and
  // avoid regressing on the cost summation.
  describe("parseMonthlyCost", () => {
    it("returns 0 for known free-tier labels", () => {
      expect(parseMonthlyCost("Free")).toBe(0);
      expect(parseMonthlyCost("N/A")).toBe(0);
      expect(parseMonthlyCost("Pay per use")).toBe(0);
      expect(parseMonthlyCost("Unavailable")).toBe(0);
      // Case-insensitive per the production regex.
      expect(parseMonthlyCost("FREE")).toBe(0);
      expect(parseMonthlyCost("free")).toBe(0);
    });

    it("returns 0 for empty string", () => {
      expect(parseMonthlyCost("")).toBe(0);
    });

    it("parses $X.XX/mo into a raw monthly number", () => {
      expect(parseMonthlyCost("$12.34/mo")).toBe(12.34);
      expect(parseMonthlyCost("$0.20/mo")).toBe(0.2);
    });

    it("parses $X.XX (no suffix) as monthly", () => {
      expect(parseMonthlyCost("$12.34")).toBe(12.34);
    });

    it("parses $X.XXXX/hr by multiplying by 730 hours/month", () => {
      // 0.0416 × 730 = 30.368 (t3.medium reference rate)
      expect(parseMonthlyCost("$0.0416/hr")).toBeCloseTo(30.368, 3);
    });

    it("returns null for unparseable strings", () => {
      expect(parseMonthlyCost("weird value")).toBeNull();
      expect(parseMonthlyCost("$abc/mo")).toBeNull();
      // Note: a leading "-$5.00/mo" is NOT rejected — the regex anchors
      // on `$[0-9]+` so it parses to 5 (the leading "-" is ignored).
      // In practice the list service never emits negative costs, so
      // tightening the regex is future work, not a blocker.
    });
  });
});
