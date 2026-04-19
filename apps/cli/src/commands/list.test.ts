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

/**
 * Reset commander option state on the shared listCommand singleton.
 * Commander 12 retains parsed values across `parseAsync` calls, so any
 * test that exercises a `--flag value` option must wipe the retained
 * value on teardown or the next test will inherit it. Public API
 * (`listCommand.opts()`) is read-only; we reach into `_optionValues`
 * via an assertion because vitest is the only caller.
 */
async function resetListCommandOptions(): Promise<void> {
  const { listCommand } = await import("./list.js");
  const internals = listCommand as unknown as {
    _optionValues: Record<string, unknown>;
  };
  for (const opt of listCommand.options) {
    internals._optionValues[opt.attributeName()] = undefined;
  }
}

describe("assignee list command", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await resetListCommandOptions();
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

    expect(fetchManagedResources).toHaveBeenCalledWith("eu-west-1", undefined);
  });

  // Story 56-it1-01: --resource-type filter parity with MCP
  // list_managed_resources tool. The validated CFN-form string is
  // forwarded to the shared core function so CLI and MCP return the
  // same filtered result set.
  it("--resource-type S3 normalises to AWS::S3::Bucket and forwards it", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([
      MOCK_RESOURCES[0]!,
    ]);

    await runListCommand(["--resource-type", "S3"]);

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::S3::Bucket",
    );
    expect(renderResourceTable).toHaveBeenCalledWith([MOCK_RESOURCES[0]]);
  });

  it("--resource-type AWS::Lambda::Function (full CFN) is forwarded as-is", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([
      MOCK_RESOURCES[1]!,
    ]);

    await runListCommand(["--resource-type", "AWS::Lambda::Function"]);

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::Lambda::Function",
    );
    expect(renderResourceTable).toHaveBeenCalledWith([MOCK_RESOURCES[1]]);
  });

  it("--resource-type INVALID errors with the SSO supported-types hint", async () => {
    await expect(
      runListCommand(["--resource-type", "NOT-A-REAL-TYPE"]),
    ).rejects.toThrow(/Unknown --resource-type "NOT-A-REAL-TYPE"/);

    // AWS must NOT have been hit when validation fails.
    expect(fetchManagedResources).not.toHaveBeenCalled();

    // The rendered error embeds the SSO-authoritative grouped list.
    expect(renderError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown --resource-type "NOT-A-REAL-TYPE"'),
      expect.stringContaining("AWS::S3::Bucket"),
      expect.objectContaining({
        // The AssigneeError.message contains the rendered hint, which
        // starts with the registry-derived count header.
        why: expect.stringContaining("What you can create"),
      }),
    );
  });

  it("no --resource-type flag leaves the filter undefined (regression)", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand();

    expect(fetchManagedResources).toHaveBeenCalledWith(undefined, undefined);
    expect(renderResourceTable).toHaveBeenCalledWith(MOCK_RESOURCES);
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
