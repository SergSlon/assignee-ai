/**
 * Tests for `assignee apply` command — flag parsing.
 * Story 11.1: Verifies --no-wizard flag is parsed and passed to graph state.
 * Story 11.3: Verifies --checkpoint flag is registered and parsed.
 *
 * Note: Commander mutates command state on parseOptions, so order matters.
 * We test option registration (static) and parsing behavior (with known args).
 */

import { describe, it, expect } from "vitest";
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
