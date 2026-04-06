/**
 * Tests for `assignee clean` CLI command (Story 33.3, Story 36.4).
 *
 * Mocks runFullCleanup and formatCleanupReport to verify the command's
 * flag-parsing, output routing, and dry-run default behaviour.
 * Also tests the --resources flag for AWS resource cleanup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Hoisted mocks ─────────────────────────────────────────────────
const {
  mockPlanBulkDestroy,
  mockDestroySingleResource,
  mockSpinnerStart,
  mockSpinnerStop,
  mockSpinnerMessage,
  mockText,
  mockIsCancel,
  mockLogInfo,
  mockLogWarn,
  mockLogError,
} = vi.hoisted(() => ({
  mockPlanBulkDestroy: vi.fn(),
  mockDestroySingleResource: vi.fn(),
  mockSpinnerStart: vi.fn(),
  mockSpinnerStop: vi.fn(),
  mockSpinnerMessage: vi.fn(),
  mockText: vi.fn(),
  mockIsCancel: vi.fn().mockReturnValue(false),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock("../services/cleanup.js", () => ({
  runFullCleanup: vi.fn(),
  formatCleanupReport: vi.fn(),
}));

vi.mock("../services/memory.js", () => ({
  MemoryService: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  text: (...args: unknown[]) => mockText(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mockSpinnerMessage,
  }),
  log: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    success: vi.fn(),
  },
}));

vi.mock("../services/bulk-destroy.js", () => ({
  planBulkDestroy: (...args: unknown[]) => mockPlanBulkDestroy(...args),
}));

vi.mock("../services/destroy-service.js", () => ({
  destroySingleResource: (...args: unknown[]) =>
    mockDestroySingleResource(...args),
}));

import { createCleanCommand } from "./clean.js";
import { intro, outro, note } from "@clack/prompts";
import {
  runFullCleanup,
  formatCleanupReport,
  type CleanupReport,
} from "../services/cleanup.js";

// ─── Helpers ────────────────────────────────────────────────────────

const mockRunFullCleanup = runFullCleanup as ReturnType<typeof vi.fn>;
const mockFormatCleanupReport = formatCleanupReport as ReturnType<typeof vi.fn>;

/** A sample non-zero report. */
const sampleReport: CleanupReport = {
  checkpoints: { pruned: 5, kept: 3 },
  cache: { removed: 12, remaining: 8 },
  memory: { provisions: 10, failures: 5, patterns: 2 },
};

/** A zero-count report. */
const zeroReport: CleanupReport = {
  checkpoints: { pruned: 0, kept: 0 },
  cache: { removed: 0, remaining: 0 },
  memory: { provisions: 0, failures: 0, patterns: 0 },
};

/** Create a fresh command and parse with the given argv tokens. */
async function run(...argv: string[]): Promise<void> {
  const cmd = createCleanCommand();
  await cmd.parseAsync(["node", "clean", ...argv]);
}

/** Capture stdout.write calls and return joined output. */
function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockRunFullCleanup.mockResolvedValue(sampleReport);
  mockFormatCleanupReport.mockReturnValue("formatted-report");
  process.exitCode = undefined;
});

describe("assignee clean", () => {
  // ── Dry-run default ───────────────────────────────────────────────

  it("defaults to dry-run when no --confirm or --yes is passed", async () => {
    await run();

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("shows formatted report and hint to run with --confirm in dry-run mode", async () => {
    await run();

    expect(note).toHaveBeenCalledWith("formatted-report");
    expect(outro).toHaveBeenCalledWith("Run with --confirm to execute.");
  });

  // ── --confirm ─────────────────────────────────────────────────────

  it("calls runFullCleanup with dryRun: false when --confirm is passed", async () => {
    await run("--confirm");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("shows 'Done.' after confirmed cleanup", async () => {
    await run("--confirm");

    expect(outro).toHaveBeenCalledWith("Done.");
  });

  // ── --yes alias ───────────────────────────────────────────────────

  it("treats --yes identically to --confirm", async () => {
    await run("--yes");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
  });

  // ── --json output ─────────────────────────────────────────────────

  it("outputs valid JSON to stdout when --json is passed (dry-run)", async () => {
    const capture = captureStdout();
    try {
      await run("--json");
      const raw = capture.output();
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(sampleReport);
      // No clack prompts should be used
      expect(intro).not.toHaveBeenCalled();
      expect(outro).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalled();
    } finally {
      capture.restore();
    }
  });

  it("outputs valid JSON to stdout when --json --confirm is passed", async () => {
    const capture = captureStdout();
    try {
      await run("--json", "--confirm");
      const raw = capture.output();
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(sampleReport);
    } finally {
      capture.restore();
    }
  });

  // ── Category flags ────────────────────────────────────────────────

  it("passes categories=['checkpoints'] when --checkpoints is used", async () => {
    await run("--checkpoints");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["checkpoints"] }),
    );
  });

  it("passes categories=['cache'] when --cache is used", async () => {
    await run("--cache");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["cache"] }),
    );
  });

  it("passes categories=['memory'] when --memory is used", async () => {
    await run("--memory");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["memory"] }),
    );
  });

  it("passes categories=['checkpoints','cache'] for combined flags", async () => {
    await run("--checkpoints", "--cache");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ categories: ["checkpoints", "cache"] }),
    );
  });

  it("passes undefined categories when no category flag is used (all)", async () => {
    await run();

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ categories: undefined }),
    );
  });

  // ── Nothing to clean ──────────────────────────────────────────────

  it("shows 'Nothing to clean.' when report is all zeros", async () => {
    mockRunFullCleanup.mockResolvedValue(zeroReport);

    await run();

    expect(outro).toHaveBeenCalledWith("Nothing to clean.");
    expect(note).not.toHaveBeenCalled();
  });

  // ── --dry-run explicit flag ───────────────────────────────────────

  it("accepts explicit --dry-run flag (still dry-run)", async () => {
    await run("--dry-run");

    expect(mockRunFullCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  // ── Error handling ────────────────────────────────────────────────

  it("sets process.exitCode to 1 on error", async () => {
    mockRunFullCleanup.mockRejectedValue(new Error("disk full"));

    await run();

    expect(process.exitCode).toBe(1);
  });

  // ── --resources flag (Story 36.4) ────────────────────────────────

  describe("--resources flag", () => {
    const sampleResources = [
      {
        arn: "arn:aws:ssm:us-east-1:123:parameter/e2e-test/param1",
        resourceType: "AWS::SSM::Parameter",
        identifier: "/e2e-test/param1",
        region: "us-east-1",
        tier: 1,
      },
      {
        arn: "arn:aws:s3:::test-bucket-123",
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket-123",
        region: "us-east-1",
        tier: 5,
      },
    ];

    const emptyPlan = {
      resources: [],
      totalCount: 0,
      iamCount: 0,
      excludedCount: 0,
    };

    const samplePlan = {
      resources: sampleResources,
      totalCount: 2,
      iamCount: 0,
      excludedCount: 0,
    };

    beforeEach(() => {
      mockPlanBulkDestroy.mockResolvedValue(emptyPlan);
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "",
        identifier: "",
        arn: "",
      });
    });

    it("calls planBulkDestroy with strict e2e/test prefix pattern when --resources is passed", async () => {
      await run("--resources", "--confirm");

      expect(mockPlanBulkDestroy).toHaveBeenCalledWith({
        pattern: expect.any(RegExp),
      });
      const regex = mockPlanBulkDestroy.mock.calls[0]![0].pattern as RegExp;
      // Strict anchored prefixes: e2e-test/, e2e-, assignee-e2e-, poc-apply-test-
      expect(regex.test("e2e-test-bucket")).toBe(true);
      expect(regex.test("assignee-e2e-resource")).toBe(true);
      expect(regex.test("poc-apply-test-abc")).toBe(true);
      expect(regex.test("bucket/e2e-test/foo")).toBe(true);
      // Must NOT match production resources whose name merely contains "test"
      expect(regex.test("my-test-bucket")).toBe(false);
      expect(regex.test("test-invoice-reports")).toBe(false);
      expect(regex.test("production-db")).toBe(false);
    });

    it("shows 'No stale test resources found' when no matches", async () => {
      mockPlanBulkDestroy.mockResolvedValue(emptyPlan);

      await run("--resources", "--confirm");

      expect(mockLogInfo).toHaveBeenCalledWith(
        "No stale test resources found.",
      );
    });

    it("displays resource table when matches found", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);

      await run("--resources", "--confirm");

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("AWS::SSM::Parameter"),
        expect.stringContaining("2 test/e2e resources found"),
      );
    });

    it("does not destroy resources in dry-run mode", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);

      await run("--resources");

      expect(mockDestroySingleResource).not.toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenCalledWith(
        expect.stringContaining("Dry run"),
      );
    });

    it("destroys resources with --confirm and shows progress", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);

      await run("--resources", "--confirm");

      expect(mockDestroySingleResource).toHaveBeenCalledTimes(2);
      expect(mockSpinnerStart).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalledWith(
        expect.stringContaining("Cleaned 2 resources, 0 failed"),
      );
    });

    it("destroys resources with --yes and shows progress", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);

      await run("--resources", "--yes");

      expect(mockDestroySingleResource).toHaveBeenCalledTimes(2);
    });

    it("reports failures in summary", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);
      mockDestroySingleResource
        .mockResolvedValueOnce({
          success: true,
          resourceType: "AWS::SSM::Parameter",
          identifier: "/e2e-test/param1",
          arn: "arn:aws:ssm:us-east-1:123:parameter/e2e-test/param1",
        })
        .mockResolvedValueOnce({
          success: false,
          resourceType: "AWS::S3::Bucket",
          identifier: "test-bucket-123",
          arn: "arn:aws:s3:::test-bucket-123",
          error: "Access denied",
        });

      await run("--resources", "--confirm");

      expect(mockSpinnerStop).toHaveBeenCalledWith(
        "Cleaned 1 resources, 1 failed",
      );
    });

    it("skips local cleanup when only --resources is passed", async () => {
      await run("--resources", "--confirm");

      expect(mockRunFullCleanup).not.toHaveBeenCalled();
    });

    it("runs local cleanup first when --resources combined with --cache", async () => {
      await run("--resources", "--cache", "--confirm");

      expect(mockRunFullCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ categories: ["cache"] }),
      );
      expect(mockPlanBulkDestroy).toHaveBeenCalled();
    });

    it("passes region to destroySingleResource for each resource", async () => {
      mockPlanBulkDestroy.mockResolvedValue(samplePlan);

      await run("--resources", "--yes");

      expect(mockDestroySingleResource).toHaveBeenCalledWith(
        expect.objectContaining({ region: "us-east-1" }),
        expect.objectContaining({ region: "us-east-1", silent: true }),
      );
    });
  });
});
