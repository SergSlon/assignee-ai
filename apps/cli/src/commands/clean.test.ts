/**
 * Tests for `assignee clean` CLI command (Story 33.3).
 *
 * Mocks runFullCleanup and formatCleanupReport to verify the command's
 * flag-parsing, output routing, and dry-run default behaviour.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

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
});
