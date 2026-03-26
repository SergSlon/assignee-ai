/**
 * Tests for `assignee cache` command — clear and refresh subcommands.
 *
 * Mocks CloudFormationSchemaService, SchemaCacheWarmer, and clack prompts.
 *
 * @see Story 31.6
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockInvalidateCache = vi.fn().mockResolvedValue(undefined);
const mockWarmAll = vi.fn();

vi.mock("@assignee/core", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    CloudFormationSchemaService: class {
      invalidateCache = mockInvalidateCache;
    },
    SchemaCacheWarmer: class {
      warmAll = mockWarmAll;
    },
    SUPPORTED_TYPES_ARRAY: [
      "AWS::S3::Bucket",
      "AWS::Lambda::Function",
      "AWS::DynamoDB::Table",
    ],
  };
});

const mockLogSuccess = vi.fn();
const mockLogInfo = vi.fn();
const mockSpinnerStart = vi.fn();
const mockSpinnerStop = vi.fn();
const mockSpinnerMessage = vi.fn();

vi.mock("@clack/prompts", () => ({
  log: {
    success: (...args: unknown[]) => mockLogSuccess(...args),
    info: (...args: unknown[]) => mockLogInfo(...args),
  },
  spinner: () => ({
    start: mockSpinnerStart,
    stop: mockSpinnerStop,
    message: mockSpinnerMessage,
  }),
}));

describe("cache command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cache command is registered with correct name", async () => {
    const { cacheCommand } = await import("./cache.js");
    expect(cacheCommand.name()).toBe("cache");
    expect(cacheCommand.description()).toBe(
      "Manage the CloudFormation schema cache",
    );
  });

  it("has 'clear' and 'refresh' subcommands", async () => {
    const { cacheCommand } = await import("./cache.js");
    const subcommands = cacheCommand.commands.map((c) => c.name());
    expect(subcommands).toContain("clear");
    expect(subcommands).toContain("refresh");
  });

  describe("cache clear", () => {
    it("calls invalidateCache and shows success message", async () => {
      const { cacheCommand } = await import("./cache.js");
      const clearCmd = cacheCommand.commands.find((c) => c.name() === "clear");
      expect(clearCmd).toBeDefined();

      await clearCmd!.parseAsync(["node", "clear"], { from: "user" });

      expect(mockInvalidateCache).toHaveBeenCalled();
      expect(mockLogSuccess).toHaveBeenCalledWith("Schema cache cleared");
    });
  });

  describe("cache refresh", () => {
    it("clears cache and warms all schemas with zero failures", async () => {
      mockWarmAll.mockResolvedValue({
        succeeded: [
          "AWS::S3::Bucket",
          "AWS::Lambda::Function",
          "AWS::DynamoDB::Table",
        ],
        failed: [],
      });

      const { cacheCommand } = await import("./cache.js");
      const refreshCmd = cacheCommand.commands.find(
        (c) => c.name() === "refresh",
      );

      await refreshCmd!.parseAsync(["node", "refresh"], { from: "user" });

      expect(mockInvalidateCache).toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenCalledWith(
        "Schema cache cleared, re-fetching...",
      );
      expect(mockSpinnerStart).toHaveBeenCalledWith(
        "Pre-fetching resource schemas...",
      );
      expect(mockWarmAll).toHaveBeenCalled();
      expect(mockSpinnerStop).toHaveBeenCalledWith(
        expect.stringContaining("Cached 3/3"),
      );
    });

    it("reports partial failures in spinner stop message", async () => {
      mockWarmAll.mockResolvedValue({
        succeeded: ["AWS::S3::Bucket", "AWS::Lambda::Function"],
        failed: ["AWS::DynamoDB::Table"],
      });

      const { cacheCommand } = await import("./cache.js");
      const refreshCmd = cacheCommand.commands.find(
        (c) => c.name() === "refresh",
      );

      await refreshCmd!.parseAsync(["node", "refresh"], { from: "user" });

      expect(mockSpinnerStop).toHaveBeenCalledWith(
        expect.stringContaining("2/3"),
      );
      expect(mockSpinnerStop).toHaveBeenCalledWith(
        expect.stringContaining("1 will be fetched on-demand"),
      );
    });

    it("invokes onProgress callback during warming", async () => {
      mockWarmAll.mockImplementation(
        async (
          _types: string[],
          opts: { onProgress: (done: number, total: number) => void },
        ) => {
          opts.onProgress(1, 3);
          opts.onProgress(2, 3);
          opts.onProgress(3, 3);
          return { succeeded: ["a", "b", "c"], failed: [] };
        },
      );

      const { cacheCommand } = await import("./cache.js");
      const refreshCmd = cacheCommand.commands.find(
        (c) => c.name() === "refresh",
      );

      await refreshCmd!.parseAsync(["node", "refresh"], { from: "user" });

      expect(mockSpinnerMessage).toHaveBeenCalledWith(
        "Pre-fetching resource schemas... 1/3",
      );
      expect(mockSpinnerMessage).toHaveBeenCalledWith(
        "Pre-fetching resource schemas... 3/3",
      );
    });
  });
});
