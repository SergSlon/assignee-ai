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

// Hoisted mock shim for node:fs so we can force readPackageVersion's
// readFileSync call to throw on demand (Epic 61-it1-01 L3-001 test).
// The shim defaults to the real module implementation so every other
// test in this file — including the tests that read the real package.json
// via `readCliPackageVersion` below — keeps working unchanged. Individual
// tests call `__fsControl.readFileSyncImpl = ...` to override.
const __fsControl = vi.hoisted(() => {
  return {
    readFileSyncImpl: null as ((...args: unknown[]) => unknown) | null,
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: ((...args: Parameters<typeof original.readFileSync>) => {
      if (__fsControl.readFileSyncImpl) {
        return __fsControl.readFileSyncImpl(...args);
      }
      return original.readFileSync(...args);
    }) as typeof original.readFileSync,
  };
});

// Imported AFTER the vi.mock hoist (vi.mock is auto-hoisted above all
// imports in the test file, so static imports here are safe). The SUT
// picks up the shimmed readFileSync via the same mocked `node:fs`.
import { versionCommand, readPackageVersion } from "../commands/version.js";

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

  it("warns to stderr and returns 0.0.0 when package.json is unreadable (Epic 61-it1-01 L3-001)", () => {
    // Force the readFileSync path used by readPackageVersion to throw so we
    // exercise the catch branch. `__fsControl` is the hoisted shim defined
    // at the top of this file — setting `readFileSyncImpl` makes the
    // shimmed node:fs readFileSync delegate to our thrower instead of the
    // real one. This reaches into the SUT (commands/version.ts) because
    // it imports readFileSync from the same shimmed module.
    __fsControl.readFileSyncImpl = () => {
      throw new Error("ENOENT: no such file or directory");
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const version = readPackageVersion();

      // Fallback semantics preserved — callers still get a printable string.
      expect(version).toBe("0.0.0");

      // Operator-visible warning emitted BEFORE the fallback is returned.
      // We assert on substrings so minor wording tweaks don't break the
      // regression signal; the informative phrase + remediation hint are
      // the durable parts of the contract.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warned = warnSpy.mock.calls[0]?.[0];
      expect(typeof warned).toBe("string");
      expect(warned).toContain("package.json version unreadable");
      expect(warned).toContain("0.0.0");
      expect(warned).toContain("Reinstall");
    } finally {
      __fsControl.readFileSyncImpl = null;
      warnSpy.mockRestore();
    }
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
