/**
 * Tests for the `assignee version` subcommand.
 *
 * Story 58-it1-03 — the command used to be registered inline in
 * `src/index.ts` via `.command("version")`, which meant the
 * completion generator had to maintain a hand-rolled stub copy with
 * the same name + description. Extracting it to a real module
 * (`src/commands/version.ts`) lets both the runtime CLI and the
 * generator consume one source of truth via `program.addCommand`.
 *
 * These tests guard:
 *   1. Output contains the CLI package version (parity with --version).
 *   2. Output contains Node + platform + MCP pins (the richer surface
 *      that distinguishes this subcommand from the --version flag).
 *   3. The exported command is addCommand-compatible — i.e. it appears
 *      in `program.commands` after `program.addCommand(versionCommand)`,
 *      which is what the completion generator walks.
 *
 * We run the command via `commander.parseAsync([...], { from: "user" })`
 * so the real action handler fires — no mocks on the command itself.
 * Only `process.stdout.write` is spied so test output stays readable.
 *
 * @see apps/cli/src/commands/version.ts
 * @see apps/cli/scripts/generate-completions.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
import { versionCommand } from "../commands/version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read the actual package version from `apps/cli/package.json` so the
 * test assertion tracks the real value rather than a hard-coded string.
 * This mirrors how `src/index.ts` and `src/commands/version.ts` both
 * resolve it — keeping the test honest if the package version bumps.
 */
function readCliPackageVersion(): string {
  const pkgPath = resolve(__dirname, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

describe("version command", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  /**
   * Collect every chunk written to process.stdout during the action,
   * then return them joined so assertions can match multi-line output.
   */
  function captureStdout(): () => string {
    const chunks: string[] = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    return () => chunks.join("");
  }

  beforeEach(() => {
    // Fresh spy per test — the action writes to stdout and we don't
    // want cross-test bleed if vitest reuses worker state.
  });

  afterEach(() => {
    stdoutSpy?.mockRestore();
  });

  it("prints the current CLI package version", async () => {
    const getOutput = captureStdout();
    const expectedVersion = readCliPackageVersion();

    // `from: "user"` tells commander not to strip argv[0]/argv[1].
    // We invoke via a fresh Command tree so no other subcommands
    // steal the args.
    const program = new Command();
    program.name("assignee");
    program.addCommand(versionCommand);

    await program.parseAsync(["version"], { from: "user" });

    const output = getOutput();
    expect(output).toContain(`assignee ${expectedVersion}`);
  });

  it("prints Node version, platform, and pinned MCP server versions", async () => {
    const getOutput = captureStdout();

    const program = new Command();
    program.name("assignee");
    program.addCommand(versionCommand);

    await program.parseAsync(["version"], { from: "user" });

    const output = getOutput();

    // Node + platform stamps — essential triage info in bug reports.
    expect(output).toContain(`node     ${process.version}`);
    expect(output).toContain(`platform ${process.platform} ${process.arch}`);

    // MCP pin section header plus each of the 5 canonical pins.
    // We don't hard-code the pin versions themselves because they
    // bump independently; we just assert the keys are all present
    // (a missing key here means a pin was dropped from MCP_PINS,
    // which is a real regression).
    expect(output).toContain("Pinned MCP servers:");
    expect(output).toMatch(/pricing\s+\S+/);
    expect(output).toMatch(/documentation\s+\S+/);
    expect(output).toMatch(/iam\s+\S+/);
    expect(output).toMatch(/wa-security\s+\S+/);
    expect(output).toMatch(/cost-mgmt\s+\S+/);
  });

  it("is discoverable by a completion-generator-style tree walk", () => {
    // The whole point of the refactor: `program.addCommand(versionCommand)`
    // MUST make the command visible under `program.commands`, which is what
    // `extractCommands` in `services/completion-generator/extract.ts` walks.
    // If this test ever fails, shell completions will silently drop `version`.
    const program = new Command();
    program.name("assignee");
    program.addCommand(versionCommand);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain("version");

    // Description stays greppable so `assignee --help` and the generated
    // zsh/bash/fish completion descriptions match.
    const found = program.commands.find((c) => c.name() === "version");
    expect(found?.description()).toBe("Show version and environment info");
  });
});
