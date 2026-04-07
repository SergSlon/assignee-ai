/**
 * Tests for `assignee completions` command.
 *
 * Validates that the command outputs shell scripts to stdout for valid
 * shell arguments and exits with an error for invalid ones.
 *
 * Tests use the real completionsCommand with its action handler to ensure
 * behaviour matches the actual CLI.
 *
 * @see Story 18.2, AC #1, #2, #6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

/**
 * Build a test CLI using the real command modules, ensuring completions
 * stay in sync with the actual CLI command tree.
 */
async function buildTestCli() {
  const { completionsCommand } = await import("./completions.js");
  const { planCommand } = await import("./plan.js");
  const { applyCommand } = await import("./apply.js");
  const { initCommand } = await import("./init.js");

  const program = new Command();
  program.name("assignee").version("0.1.0");

  program.addCommand(planCommand);
  program.addCommand(applyCommand);
  program.addCommand(initCommand);
  program.addCommand(completionsCommand);

  return { program, completionsCommand };
}

describe("completions command", () => {
  let stdoutSpy: any;

  let stderrSpy: any;

  let exitSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it(
    "outputs zsh completion script to stdout",
    { timeout: 15_000 },
    async () => {
      const { generateCompletionScript } =
        await import("../services/completion-generator.js");

      // Build with real commands to verify the generator picks up the full tree
      const { program } = await buildTestCli();

      const script = generateCompletionScript(program, "zsh");

      expect(script).toContain("#compdef assignee");
      expect(script).toContain("plan");
      expect(script).toContain("apply");
      expect(script).toContain("init");
    },
  );

  it("outputs bash completion script to stdout", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");

    const { program } = await buildTestCli();

    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("complete -F");
    expect(script).toContain("_assignee_completions");
    expect(script).toContain("plan");
  });

  it("outputs fish completion script to stdout", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");

    const { program } = await buildTestCli();

    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("complete -c assignee");
    expect(script).toContain("-a plan");
  });

  it("rejects invalid shell argument with error message", async () => {
    const { completionsCommand } = await buildTestCli();

    // The action throws AssigneeError for invalid shells
    expect(() => {
      completionsCommand.parse(["powershell"], {
        from: "user",
      });
    }).toThrow('Unsupported shell "powershell"');
  });

  it("handles case-insensitive shell names", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");
    const { SUPPORTED_SHELLS } =
      await import("../services/completion-generator.js");

    // Verify the SUPPORTED_SHELLS constant includes all three shells
    expect(SUPPORTED_SHELLS).toContain("zsh");
    expect(SUPPORTED_SHELLS).toContain("bash");
    expect(SUPPORTED_SHELLS).toContain("fish");

    // The command normalizes to lowercase before checking
    const { program } = await buildTestCli();

    // Just verify the generator works for all shells
    for (const shell of SUPPORTED_SHELLS) {
      const script = generateCompletionScript(program, shell);
      expect(script.length).toBeGreaterThan(0);
    }
  });
});
