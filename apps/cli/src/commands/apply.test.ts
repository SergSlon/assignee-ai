/**
 * Tests for `assignee apply` command — flag parsing.
 * Story 11.1: Verifies --no-wizard flag is parsed and passed to graph state.
 * Story 11.3: Verifies --checkpoint flag is registered and parsed.
 * Epic 92 Wave 3.b.1: Help-text consolidation (C-24 / D-02) and flag
 *   surface assertions (D-13) — apply --help must emit ONE Examples
 *   block with apply-specific invocations (no plan examples leaked),
 *   and both `--wizard` + `-q, --quick` must remain registered.
 *
 * Note: Commander mutates command state on parseOptions, so order matters.
 * We test option registration (static) and parsing behavior (with known args).
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

/**
 * Creates a fresh Command instance with the same option shape as applyCommand.
 * This avoids shared mutable state between tests.
 */
function createTestCommand(): Command {
  return new Command("apply")
    .argument("[intent]", "The intent")
    .option("--no-wizard", "Skip interactive option prompts, use defaults")
    .option(
      "-y, --yes",
      "Auto-confirm apply without interactive prompt (for CI/CD)",
    )
    .option(
      "-c, --checkpoint <path>",
      "Use a saved plan checkpoint instead of running Phase 1",
    );
}

describe("applyCommand — --no-wizard flag parsing (Story 11.1)", () => {
  it("--no-wizard option is registered on the command", () => {
    const cmd = createTestCommand();
    const noWizardOption = cmd.options.find(
      (opt) => opt.long === "--no-wizard",
    );
    // Wave 18: strengthened — assert by long-flag name. The previous
    // `toBeDefined()` would have passed even if `find()` returned a
    // different option (the description chain below uses `?.` so
    // optional-chained undefined silently failed at the `toBe(...)`
    // line, producing a confusing diagnostic).
    expect(noWizardOption?.long).toBe("--no-wizard");
    expect(noWizardOption?.description).toBe(
      "Skip interactive option prompts, use defaults",
    );
  });

  it("opts.wizard is false when --no-wizard flag is present", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["--no-wizard", "Create an S3 bucket"]);
    expect(cmd.opts()["wizard"]).toBe(false);
  });

  it("opts.wizard is true when --no-wizard is absent (Commander negation default)", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["Create an S3 bucket"]);
    expect(cmd.opts()["wizard"]).toBe(true);
  });
});

describe("applyCommand — --checkpoint flag parsing (Story 11.3)", () => {
  it("--checkpoint / -c option is registered on the command", () => {
    const cmd = createTestCommand();
    const cpOption = cmd.options.find((opt) => opt.long === "--checkpoint");
    // Wave 18: strengthened — assert by long-flag name (see --no-wizard).
    expect(cpOption?.long).toBe("--checkpoint");
    expect(cpOption?.short).toBe("-c");
    expect(cpOption?.description).toBe(
      "Use a saved plan checkpoint instead of running Phase 1",
    );
  });

  it("opts.checkpoint is set when --checkpoint flag is provided", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["--checkpoint", ".assignee/checkpoint-abc.json"]);
    expect(cmd.opts()["checkpoint"]).toBe(".assignee/checkpoint-abc.json");
  });

  it("opts.checkpoint is set when -c shorthand is used", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["-c", ".assignee/checkpoint-abc.json"]);
    expect(cmd.opts()["checkpoint"]).toBe(".assignee/checkpoint-abc.json");
  });

  it("opts.checkpoint is undefined when not provided", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["Create an S3 bucket"]);
    expect(cmd.opts()["checkpoint"]).toBeUndefined();
  });

  it("--checkpoint and --yes can be composed", () => {
    const cmd = createTestCommand();
    cmd.parseOptions(["--checkpoint", ".assignee/cp.json", "--yes"]);
    expect(cmd.opts()["checkpoint"]).toBe(".assignee/cp.json");
    expect(cmd.opts()["yes"]).toBe(true);
  });

  it("intent argument is optional (not required when checkpoint is used)", () => {
    const cmd = createTestCommand();
    // parseOptions with only --checkpoint and no positional arg
    const result = cmd.parseOptions(["--checkpoint", ".assignee/cp.json"]);
    expect(cmd.opts()["checkpoint"]).toBe(".assignee/cp.json");
    // No positional operands
    expect(result.operands).toHaveLength(0);
  });
});

// ── Epic 92 Wave 3.b.1 — help text consolidation (C-24 / D-02) ─────────────
// Commander 12's `helpInformation()` intentionally does NOT concat the
// `addHelpText()` payloads — those emit through the `beforeHelp` /
// `afterHelp` event hooks during `outputHelp()`. To assert against the
// fully-rendered help we re-run it with a capture `write` callback.
function captureFullHelp(cmd: Command): string {
  let captured = "";
  cmd.outputHelp({
    write: (chunk: string) => {
      captured += chunk;
    },
  } as unknown as { error: boolean });
  return captured;
}

describe("applyCommand — help text (Epic 92 C-24 / D-02)", () => {
  // The parent `program` in index.ts also registers an
  // `addHelpText("after", ...)` block that emits a command-neutral
  // `Examples:` listing; that global block is owned by a different
  // wave (help-hints-core). These tests assert the PER-COMMAND block
  // is correctly shaped (apply-specific) and that the per-command
  // `addHelpText` itself is ONE consolidated call (not scattered).
  it("apply command registers exactly one addHelpText(after) entry on itself", async () => {
    const { applyCommand } = await import("./apply.js");
    // Commander keeps per-command addHelpText listeners on the
    // command's EventEmitter under 'afterHelp' (the event the
    // "after" position emits). We count the listeners directly.
    const listeners = (
      applyCommand as unknown as {
        listeners: (evt: string) => unknown[];
      }
    ).listeners("afterHelp");
    // Exactly one — the consolidated block installed in apply.ts.
    expect(listeners.length).toBe(1);
  });

  it("apply --help per-command Examples block lists apply-specific invocations", async () => {
    const { applyCommand } = await import("./apply.js");
    const helpText = captureFullHelp(applyCommand);
    // Apply-specific invocations must all be present (these only
    // appear in the per-command block — the global block uses plan
    // examples).
    expect(helpText).toContain('assignee apply "');
    expect(helpText).toContain("--checkpoint");
    expect(helpText).toContain("--wizard");
    expect(helpText).toContain("--set");
    // The checkpoint path format is the tell that we're looking at
    // the per-command block (the global block does not include it).
    expect(helpText).toContain(".assignee/checkpoint-abc.json");
  });

  it("apply --help includes --yes example for CI/CD users", async () => {
    const { applyCommand } = await import("./apply.js");
    const helpText = captureFullHelp(applyCommand);
    expect(helpText).toContain("--yes");
  });
});

// ── Epic 92 Wave 3.b.1 — flag surface (D-13) ────────────────────────────
describe("applyCommand — flag surface (Epic 92 D-13)", () => {
  it("registers --wizard boolean flag (opt-in wizard mode)", async () => {
    const { applyCommand } = await import("./apply.js");
    const wizard = applyCommand.options.find((o) => o.long === "--wizard");
    expect(wizard?.long).toBe("--wizard");
    expect(wizard?.flags).toBe("--wizard");
  });

  it("registers -q / --quick flag (skip defaulted prompts)", async () => {
    const { applyCommand } = await import("./apply.js");
    const quick = applyCommand.options.find((o) => o.long === "--quick");
    expect(quick?.long).toBe("--quick");
    expect(quick?.short).toBe("-q");
  });

  it("--wizard and --quick remain distinct flags (both registered)", async () => {
    const { applyCommand } = await import("./apply.js");
    const longFlags = applyCommand.options.map((o) => o.long);
    expect(longFlags).toContain("--wizard");
    expect(longFlags).toContain("--quick");
  });
});

// ── W4-S5 — --target-account user-facing message (M-β-01) ───────────────────
// Verifies that --target-account exits NOT_IMPLEMENTED without leaking
// internal tracker strings ("Epic 101", "story", "W3-04") in stderr.

describe("applyCommand — --target-account NOT_IMPLEMENTED message (W4-S5)", () => {
  it("exits NOT_IMPLEMENTED (12) for a valid 12-digit account ID", async () => {
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrCalls.push(String(chunk));
        return true;
      });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);

    try {
      const { applyCommand } = await import("./apply.js");
      await applyCommand.parseAsync([
        "node",
        "apply",
        "--target-account",
        "123456789012",
        "Create an S3 bucket",
      ]);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const stderrText = stderrCalls.join("");
    // Must contain user-facing intent keywords.
    expect(stderrText).toContain("cross-account");
    expect(stderrText).toContain("not yet available");
    // Must NOT leak internal tracker names.
    expect(stderrText).not.toMatch(/Epic\s+\d+/i);
    expect(stderrText).not.toMatch(/story\s+\d+-W\d+/i);
    // Exit code must be NOT_IMPLEMENTED (12).
    expect(exitSpy).toHaveBeenCalledWith(12);
  });
});
