/**
 * Tests for the shell completion script generator.
 *
 * Validates that generated completion scripts include all registered
 * commands and flags, and use correct shell-specific syntax.
 *
 * @see Story 18.2, AC #3, #4, #6
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";
import {
  generateCompletionScript,
  extractCommands,
} from "./completion-generator.js";

/**
 * Build a minimal Commander.js program that mirrors the real assignee CLI
 * command tree for testing purposes.
 */
function buildTestProgram(): Command {
  const program = new Command();
  program.name("assignee").version("0.1.0");

  program
    .command("plan")
    .description("Generate an infrastructure plan from natural language intent")
    .argument("[intent]", "Natural language description")
    .option("-o, --output <format>", "Output format (json|text)")
    .option("--no-apply", "Skip the apply prompt after plan display");

  program
    .command("apply")
    .description("Execute an approved infrastructure plan")
    .argument("[intent]", "Natural language description")
    .option("--no-wizard", "Skip interactive option prompts, use defaults")
    .option("--yes", "Skip confirmation prompt (CI mode)")
    .option("--checkpoint <file>", "Resume from a checkpoint file");

  program
    .command("init")
    .description("Initialize assignee.ai project configuration");

  program
    .command("completions")
    .description("Output shell completion script")
    .argument("<shell>", "Shell type: zsh, bash, or fish");

  return program;
}

// ── extractCommands ─────────────────────────────────────────────────────────

describe("extractCommands", () => {
  it("extracts all registered commands", () => {
    const program = buildTestProgram();
    const commands = extractCommands(program);
    const names = commands.map((c) => c.name);

    expect(names).toContain("plan");
    expect(names).toContain("apply");
    expect(names).toContain("init");
    expect(names).toContain("completions");
  });

  it("extracts options with long and short flags", () => {
    const program = buildTestProgram();
    const commands = extractCommands(program);
    const planCmd = commands.find((c) => c.name === "plan")!;

    // Tier C: dropped redundant toBeDefined() — find!()
    const outputOpt = planCmd.options.find((o) => o.long === "--output")!;
    expect(outputOpt.short).toBe("-o");
    expect(outputOpt.argName).toBe("format");
  });

  it("extracts options without short flags", () => {
    // Tier C: dropped redundant toBeDefined() — find!()
    const program = buildTestProgram();
    const commands = extractCommands(program);
    const applyCmd = commands.find((c) => c.name === "apply")!;

    const yesOpt = applyCmd.options.find((o) => o.long === "--yes")!;
    expect(yesOpt.short).toBeUndefined();
  });

  it("extracts command descriptions", () => {
    const program = buildTestProgram();
    const commands = extractCommands(program);
    const initCmd = commands.find((c) => c.name === "init")!;

    expect(initCmd.description).toBe(
      "Initialize assignee.ai project configuration",
    );
  });
});

// ── Zsh completion generation ───────────────────────────────────────────────

describe("generateCompletionScript - zsh", () => {
  it("contains #compdef header", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("#compdef assignee");
  });

  it("includes all registered commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("'plan:");
    expect(script).toContain("'apply:");
    expect(script).toContain("'init:");
    expect(script).toContain("'completions:");
  });

  it("includes flags for commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("--output");
    expect(script).toContain("--no-wizard");
    expect(script).toContain("--yes");
    expect(script).toContain("--checkpoint");
  });

  it("defines the _assignee function", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("_assignee()");
    expect(script).toContain("_describe 'command' commands");
  });

  it("includes install instructions as a comment", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("eval");
    expect(script).toContain("completions zsh");
  });
});

// ── Bash completion generation ──────────────────────────────────────────────

describe("generateCompletionScript - bash", () => {
  it("contains complete -F registration", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("complete -F _assignee_completions assignee");
  });

  it("includes all registered commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("plan");
    expect(script).toContain("apply");
    expect(script).toContain("init");
    expect(script).toContain("completions");
  });

  it("includes flags for commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("--output");
    expect(script).toContain("--no-wizard");
    expect(script).toContain("--yes");
    expect(script).toContain("--checkpoint");
  });

  it("defines the _assignee_completions function", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("_assignee_completions()");
    expect(script).toContain("COMPREPLY");
  });

  it("uses compgen for word matching", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("compgen -W");
  });
});

// ── Fish completion generation ──────────────────────────────────────────────

describe("generateCompletionScript - fish", () => {
  it("contains complete -c assignee lines", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("complete -c assignee");
  });

  it("includes all registered commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("-a plan");
    expect(script).toContain("-a apply");
    expect(script).toContain("-a init");
    expect(script).toContain("-a completions");
  });

  it("includes flags for commands", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("-l output");
    expect(script).toContain("-l no-wizard");
    expect(script).toContain("-l yes");
    expect(script).toContain("-l checkpoint");
  });

  it("uses __fish_use_subcommand for top-level completions", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("__fish_use_subcommand");
  });

  it("uses __fish_seen_subcommand_from for option scoping", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("__fish_seen_subcommand_from plan");
    expect(script).toContain("__fish_seen_subcommand_from apply");
  });

  it("includes short flags when available", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    // -o is the short flag for --output on the plan command
    expect(script).toContain("-s o");
  });

  it("marks options requiring arguments with -r", () => {
    const program = buildTestProgram();
    const script = generateCompletionScript(program, "fish");

    // --output and --checkpoint take arguments, so they should have -r
    expect(script).toMatch(/-l output.*-r/);
    expect(script).toMatch(/-l checkpoint.*-r/);
  });
});
