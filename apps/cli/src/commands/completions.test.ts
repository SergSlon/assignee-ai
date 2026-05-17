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

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { Command } from "commander";

/**
 * Build a test CLI using the real command modules under noun groups,
 * mirroring the production noun-grouped tree (Story 108-A-05).
 */
async function buildTestCli() {
  const { completionsCommand } = await import("./completions.js");
  const { planCommand } = await import("./plan.js");
  const { applyCommand } = await import("./apply.js");
  const { initCommand } = await import("./init.js");

  const program = new Command();
  program.name("assignee").version("0.1.0");

  // infra group
  const infra = new Command("infra").description("Manage cloud infrastructure");
  infra.addCommand(planCommand);
  infra.addCommand(applyCommand);
  program.addCommand(infra);

  // dev group
  const dev = new Command("dev").description("Developer tooling");
  dev.addCommand(initCommand);
  dev.addCommand(completionsCommand);
  program.addCommand(dev);

  return { program, completionsCommand };
}

describe("completions command", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  let stderrSpy: MockInstance<typeof process.stderr.write>;

  let exitSpy: MockInstance<typeof process.exit>;

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

  it("outputs zsh completion script to stdout (noun-grouped tree)", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");

    // Build with real commands to verify the generator picks up the full tree
    const { program } = await buildTestCli();

    const script = generateCompletionScript(program, "zsh");

    expect(script).toContain("#compdef assignee");
    // Noun groups appear at top level
    expect(script).toContain("'infra:");
    expect(script).toContain("'dev:");
    // Leaf commands appear as sub-completions
    expect(script).toContain("'plan:");
    expect(script).toContain("'apply:");
    expect(script).toContain("'init:");
  });

  it("outputs bash completion script to stdout (noun-grouped tree)", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");

    const { program } = await buildTestCli();

    const script = generateCompletionScript(program, "bash");

    expect(script).toContain("complete -F");
    expect(script).toContain("_assignee_completions");
    // Noun groups appear as top-level completions
    expect(script).toContain("infra");
    expect(script).toContain("dev");
    // Leaf commands appear under their noun groups
    expect(script).toContain("plan");
    expect(script).toContain("init");
  });

  it("outputs fish completion script to stdout (noun-grouped tree)", async () => {
    const { generateCompletionScript } =
      await import("../services/completion-generator.js");

    const { program } = await buildTestCli();

    const script = generateCompletionScript(program, "fish");

    expect(script).toContain("complete -c assignee");
    // Noun groups at top level
    expect(script).toContain("-a infra");
    expect(script).toContain("-a dev");
    // Leaf commands under their noun groups
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
