/**
 * Tests for `assignee init` command.
 *
 * @see Story 18.1, AC #9
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

// Mock @clack/prompts before importing the command
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

// Mock credential-detector
vi.mock("../services/credential-detector.js", () => ({
  detectCredentials: vi.fn(),
  detectRegion: vi.fn(),
}));

// Mock user-config-loader for --global tests
vi.mock("../config/user-config-loader.js", () => ({
  resolveConfigPath: vi.fn(),
}));

// Mock process.exit to prevent test from terminating
vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

import * as clack from "@clack/prompts";
import {
  detectCredentials,
  detectRegion,
} from "../services/credential-detector.js";
import type {
  CredentialDetectionResult,
  RegionDetectionResult,
} from "../services/credential-detector.js";
import { resolveConfigPath } from "../config/user-config-loader.js";

// ── Helpers ──────────────────────────────────────────────────────────────

let tmpDir: string;
let originalCwd: string;

async function runInitAction(args: string[] = ["node", "init"]): Promise<void> {
  // Dynamically import to get fresh module with mocks
  const { initCommand } = await import("./init.js");
  // Use parseAsync to trigger the action
  await initCommand.parseAsync(args);
}

async function runInitGlobal(): Promise<void> {
  await runInitAction(["node", "init", "--global"]);
}

function mockCredentials(result: CredentialDetectionResult): void {
  vi.mocked(detectCredentials).mockResolvedValue(result);
}

function mockRegion(result: RegionDetectionResult): void {
  vi.mocked(detectRegion).mockResolvedValue(result);
}

function mockPrompts(opts: {
  region?: string;
  profile?: string;
  environment?: string;
}): void {
  vi.mocked(clack.text)
    .mockResolvedValueOnce(opts.region ?? "us-east-1")
    .mockResolvedValueOnce(opts.profile ?? "default");
  vi.mocked(clack.select)
    // 1st select: environment
    .mockResolvedValueOnce(opts.environment ?? "development")
    // 2nd select: auto_fix (Wave-2 F6 P1-4 — 3-mode restored)
    .mockResolvedValueOnce("ask");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("assignee init command", () => {
  const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
  const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    // Epic 94 R6: the interactive-wizard tests all assume TTY context,
    // but under vitest both streams report `isTTY === undefined` so the
    // R6 guard would trip. Pin both to `true` here so the wizard path
    // runs as intended.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, "isTTY", {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("creates .assignee/config.yaml with valid credentials", async () => {
    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "eu-west-1" });
    mockPrompts({
      region: "eu-west-1",
      profile: "default",
      environment: "development",
    });

    await runInitAction();

    // Verify config file was created
    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed["region"]).toBe("eu-west-1");
    expect(parsed["profile"]).toBe("default");
    expect(parsed["tags"]).toEqual({
      "managed-by": "assignee-ai",
      environment: "development",
    });
  });

  it("config file content matches expected YAML structure", async () => {
    mockCredentials({
      detected: true,
      source: "file",
      profile: "staging",
    });
    mockRegion({ region: "us-west-2" });
    mockPrompts({
      region: "us-west-2",
      profile: "staging",
      environment: "production",
    });

    await runInitAction();

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");

    // Should have the comment header
    expect(content).toContain("# Generated by assignee init");

    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed).toEqual({
      region: "us-west-2",
      profile: "staging",
      tags: {
        "managed-by": "assignee-ai",
        environment: "production",
      },
      // Legacy boolean shape kept for back-compat (Wave-2 F6 P1-4):
      // `apply` → true; `ask`/`skip` → false. Authoritative value is
      // `preferences.auto_fix`.
      autoFixBestPractices: false,
      defaults: {
        region: "us-west-2",
        tags: {
          "managed-by": "assignee-ai",
          environment: "production",
        },
      },
      preferences: {
        auto_fix: "ask",
      },
    });
  });

  it("prompts for overwrite when config already exists", async () => {
    // Create existing config
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      "region: old-region\n",
    );

    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });

    // User declines overwrite
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    await runInitAction();

    // Verify confirm was called with the path-aware overwrite prompt.
    // Item 4b (2026-04-10): message now embeds the full resolved
    // configPath so users see exactly what they're about to overwrite.
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /Project config already exists at .*config\.yaml\. Overwrite it\?/,
        ) as unknown as string,
      }),
    );

    // Verify outro message mentions the preserved path
    expect(clack.outro).toHaveBeenCalledWith(
      expect.stringMatching(
        /Keeping existing configuration at .*config\.yaml\. No changes made\./,
      ),
    );

    // Verify original config was NOT overwritten
    const content = await fs.readFile(
      path.join(configDir, "config.yaml"),
      "utf-8",
    );
    expect(content).toBe("region: old-region\n");
  });

  it("overwrites config when user confirms", async () => {
    // Create existing config
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      "region: old-region\n",
    );

    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });

    // User confirms overwrite
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);
    mockPrompts({
      region: "us-east-1",
      profile: "default",
      environment: "development",
    });

    await runInitAction();

    // Verify config was overwritten with new content
    const content = await fs.readFile(
      path.join(configDir, "config.yaml"),
      "utf-8",
    );
    expect(content).toContain("us-east-1");
    expect(content).not.toContain("old-region");
  });

  it("succeeds without AWS credentials and prints a next-step hint", async () => {
    // Scrub all credential env vars so detectAvailableRoles sees nothing.
    const scrubbed = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_READER_ACCESS_KEY_ID",
      "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
      "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const key of scrubbed) {
      saved[key] = process.env[key];
      delete process.env[key];
    }

    try {
      mockCredentials({
        detected: false,
        reason:
          "No AWS credentials found. Configure credentials via:\n" +
          "  1) ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables\n" +
          "  2) ~/.aws/credentials file\n" +
          "  3) AWS SSO login (aws sso login)",
      });
      mockRegion({ region: "us-east-1" });
      mockPrompts({
        region: "us-east-1",
        profile: "default",
        environment: "development",
      });

      await runInitAction();

      // UX (M-T2): All no-creds messaging is consolidated into ONE warn
      // block — not 3 stacked info lines. The single warn must cover all
      // four pieces of information that used to be split:
      //   1. "No AWS credentials detected"
      //   2. The `assignee setup` next-step
      //   3. The AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY fallback
      //   4. The AWS_PROFILE-alone-unsupported note
      //   5. The "Assignee roles available: none" line
      const warnCalls = vi
        .mocked(clack.log.warn)
        .mock.calls.map((c) => String(c[0]));
      // Exactly one warn call in the no-creds path.
      expect(warnCalls).toHaveLength(1);
      const warnText = warnCalls[0]!;
      expect(warnText).toContain("No AWS credentials detected");
      expect(warnText).toContain("assignee setup");
      expect(warnText).toContain("AWS_ACCESS_KEY_ID");
      expect(warnText).toContain("AWS_SECRET_ACCESS_KEY");
      expect(warnText).toContain("AWS_PROFILE");
      expect(warnText).toContain("not currently supported");
      expect(warnText).toContain(
        "Assignee roles available: none (operator, reader, auditor all unset)",
      );

      // The redundant info-line stack must be GONE. None of the no-creds
      // messages should appear as separate clack.log.info calls.
      const infoCalls = vi
        .mocked(clack.log.info)
        .mock.calls.map((c) => String(c[0]));
      expect(
        infoCalls.some((m) => m.includes("Assignee roles available")),
      ).toBe(false);
      expect(infoCalls.some((m) => m.includes("assignee setup"))).toBe(false);

      // Config file is still written.
      const configPath = path.join(tmpDir, ".assignee", "config.yaml");
      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain("us-east-1");
      expect(clack.outro).toHaveBeenCalledWith(
        expect.stringContaining("Initialized assignee.ai for region us-east-1"),
      );
    } finally {
      for (const key of scrubbed) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it("succeeds with reader-only env credentials and reports reader available", async () => {
    const scrubbed = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_READER_ACCESS_KEY_ID",
      "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
      "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const key of scrubbed) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Real-shaped AWS access key id (AKIA + 16 alphanumerics) and secret.
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    try {
      mockCredentials({
        detected: false,
        reason: "No operator credentials found",
      });
      mockRegion({ region: "us-west-2" });
      mockPrompts({
        region: "us-west-2",
        profile: "default",
        environment: "development",
      });

      await runInitAction();

      // UX (M-T2): When creds are not detected, the roles-available info
      // is folded into the single warn block (not a separate info line).
      // Reader-only env vars must still be reported, but inside the warn.
      const warnCalls = vi
        .mocked(clack.log.warn)
        .mock.calls.map((c) => String(c[0]));
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]).toContain("Assignee roles available: reader");
      // Must NOT also emit a duplicate info line.
      const infoCalls = vi
        .mocked(clack.log.info)
        .mock.calls.map((c) => String(c[0]));
      expect(
        infoCalls.some((m) => m.includes("Assignee roles available")),
      ).toBe(false);

      const configPath = path.join(tmpDir, ".assignee", "config.yaml");
      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain("us-west-2");
    } finally {
      for (const key of scrubbed) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it("reports all 3 roles available when operator, reader, and auditor envs are set", async () => {
    const scrubbed = [
      "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
      "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      "ASSIGNEE_READER_ACCESS_KEY_ID",
      "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
      "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const key of scrubbed) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7OPERATOR";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYOPERATORKEY";
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAIOSFODNN7READER00";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYREADERKEY00";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7AUDITOR0";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYAUDITORKEY";

    try {
      mockCredentials({
        detected: true,
        source: "env",
        profile: "default",
      });
      mockRegion({ region: "us-east-1" });
      mockPrompts({
        region: "us-east-1",
        profile: "default",
        environment: "production",
      });

      await runInitAction();

      expect(clack.log.success).toHaveBeenCalledWith(
        expect.stringContaining("AWS credentials detected"),
      );
      const infoCalls = vi
        .mocked(clack.log.info)
        .mock.calls.map((c) => String(c[0]));
      expect(
        infoCalls.some(
          (m) => m === "Assignee roles available: operator, reader, auditor",
        ),
      ).toBe(true);

      const configPath = path.join(tmpDir, ".assignee", "config.yaml");
      const content = await fs.readFile(configPath, "utf-8");
      expect(content).toContain("us-east-1");
    } finally {
      for (const key of scrubbed) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });

  it("shows success summary with region and profile", async () => {
    mockCredentials({
      detected: true,
      source: "env",
      profile: "my-profile",
    });
    mockRegion({ region: "ap-southeast-1" });
    mockPrompts({
      region: "ap-southeast-1",
      profile: "my-profile",
      environment: "staging",
    });

    await runInitAction();

    expect(clack.outro).toHaveBeenCalledWith(
      expect.stringContaining(
        "Initialized assignee.ai for region ap-southeast-1",
      ),
    );
    expect(clack.outro).toHaveBeenCalledWith(
      expect.stringContaining("with profile my-profile"),
    );
    expect(clack.outro).toHaveBeenCalledWith(
      expect.stringContaining("assignee plan"),
    );
  });

  it("does not show profile note for default profile", async () => {
    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });
    mockPrompts({
      region: "us-east-1",
      profile: "default",
      environment: "development",
    });

    await runInitAction();

    const outroCall = vi.mocked(clack.outro).mock.calls[0]?.[0] as string;
    expect(outroCall).not.toContain("with profile");
  });
});

// ── Story e92-3b3 (D-05 help-text half) ────────────────────────────────
// `assignee init --help` must describe the project config directory as
// `.assignee/` (the hidden-dir convention that matches the actual target
// location). The previous text said `./assignee/` (a visible subdir),
// which was inaccurate. This test pins the fix.
//
// Note: `addHelpText("after", ...)` content is emitted via commander's
// `afterHelp` lifecycle when `outputHelp()` runs — it is NOT part of the
// string returned by `helpInformation()`. So these tests capture the
// full rendered help by routing `configureOutput` into a buffer.
describe("assignee init --help (e92-3b3 D-05 help-text half)", () => {
  async function captureInitHelp(): Promise<string> {
    const { initCommand } = await import("./init.js");
    let captured = "";
    initCommand.configureOutput({
      writeOut: (s: string) => {
        captured += s;
      },
      writeErr: (s: string) => {
        captured += s;
      },
    });
    initCommand.outputHelp();
    return captured;
  }

  it("describes the project config dir as .assignee/ (not ./assignee/)", async () => {
    const helpText = await captureInitHelp();

    expect(helpText).toContain(".assignee/");
    expect(helpText).not.toContain("./assignee/");
  });

  it("has a single consolidated Examples block in addHelpText", async () => {
    const helpText = await captureInitHelp();

    // Count "Examples:" headers — must be exactly one.
    const matches = helpText.match(/^Examples:$/gm);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("still mentions the auto-fix mode selection flow", async () => {
    const helpText = await captureInitHelp();

    expect(helpText).toContain("auto-fix");
    expect(helpText).toMatch(/ask.*apply.*skip/s);
  });
});

describe("assignee init --global", () => {
  let globalConfigDir: string;
  const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
  const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-global-test-"));
    globalConfigDir = path.join(tmpDir, ".config", "assignee");
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // Mock resolveConfigPath to use tmpDir
    vi.mocked(resolveConfigPath).mockReturnValue(
      path.join(globalConfigDir, "config.yaml"),
    );

    // Epic 94 R6: simulate TTY context so the R6 non-interactive guard
    // doesn't trip during the global wizard tests.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, "isTTY", {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("--global flag triggers global config wizard and writes AssigneeConfig YAML", async () => {
    // Mock the global wizard prompts in order:
    // 1. region (text)
    // 2. tag entry 1 (text)
    // 3. tag entry empty = done (text)
    // 4. naming prefix (text)
    // 5. auto_fix (select)
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-west-2") // region
      .mockResolvedValueOnce("team=backend") // tag 1
      .mockResolvedValueOnce("") // done with tags
      .mockResolvedValueOnce("myco-"); // naming prefix

    vi.mocked(clack.select).mockResolvedValueOnce("ask"); // auto_fix

    await runInitGlobal();

    // Verify config file was created
    const configPath = path.join(globalConfigDir, "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    expect(content).toContain("# Generated by assignee init --global");

    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    expect(defaults["region"]).toBe("us-west-2");
    expect(defaults["tags"]).toEqual({ team: "backend" });
    expect((defaults["naming"] as Record<string, unknown>)["prefix"]).toBe(
      "myco-",
    );

    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
  });

  it("auto_fix defaults to 'ask' when user presses Enter", async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-east-1") // region
      .mockResolvedValueOnce("") // done with tags
      .mockResolvedValueOnce(""); // no prefix

    vi.mocked(clack.select).mockResolvedValueOnce("ask"); // auto_fix — default

    await runInitGlobal();

    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
  });

  it("prompts for overwrite when global config already exists", async () => {
    // Create existing global config
    await fs.mkdir(globalConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(globalConfigDir, "config.yaml"),
      "defaults:\n  region: old-region\n",
    );

    // User declines overwrite
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    await runInitGlobal();

    // Item 4b (2026-04-10): prompt now embeds the full resolved path
    // so users see which file is about to be overwritten.
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(
          /Global config already exists at .*config\.yaml\. Overwrite it\?/,
        ) as unknown as string,
      }),
    );
    expect(clack.outro).toHaveBeenCalledWith(
      expect.stringMatching(
        /Keeping existing configuration at .*config\.yaml\. No changes made\./,
      ),
    );
  });

  // Note: "no --global flag" behavior is fully tested in the "assignee init command" describe block above.

  // L-A9 regression: malformed tag entries (`=value`, `key=`, no `=`) used to
  // be silently dropped. Users had no way to know their input was rejected.
  // The fix surfaces a clack.log.warn for each malformed entry.
  it("warns when tag entry has no '=' separator", async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-east-1") // region
      .mockResolvedValueOnce("environmentdev") // malformed: no `=`
      .mockResolvedValueOnce("") // done with tags
      .mockResolvedValueOnce(""); // no prefix
    vi.mocked(clack.select).mockResolvedValueOnce("ask");

    await runInitGlobal();

    expect(clack.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored tag "environmentdev"'),
    );

    // The config still wrote successfully without the bad tag.
    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown> | undefined;
    expect(defaults?.["tags"]).toBeUndefined();
  });

  it("warns when tag entry starts with '=' (empty key)", async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-east-1")
      .mockResolvedValueOnce("=lonely-value")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(clack.select).mockResolvedValueOnce("ask");

    await runInitGlobal();

    expect(clack.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored tag "=lonely-value"'),
    );
  });

  it("warns when tag entry has empty value (`key=`)", async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-east-1")
      .mockResolvedValueOnce("environment=") // empty value
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(clack.select).mockResolvedValueOnce("ask");

    await runInitGlobal();

    expect(clack.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Ignored tag "environment="'),
    );
  });

  it("accepts a valid tag and does NOT warn", async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce("us-east-1")
      .mockResolvedValueOnce("environment=production")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("");
    vi.mocked(clack.select).mockResolvedValueOnce("ask");

    await runInitGlobal();

    // No "Ignored tag" warnings — only valid entry was supplied.
    const ignoredWarnings = vi
      .mocked(clack.log.warn)
      .mock.calls.filter((c) => String(c[0] ?? "").includes("Ignored tag"));
    expect(ignoredWarnings).toHaveLength(0);

    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    expect(defaults["tags"]).toEqual({ environment: "production" });
  });
});

// ── M-S8: detectAvailableRoles delegates to @assignee/core ─────────────────

describe("detectAvailableRoles (M-S8)", () => {
  const ALL_VARS = [
    "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    "ASSIGNEE_READER_ACCESS_KEY_ID",
    "ASSIGNEE_READER_SECRET_ACCESS_KEY",
    "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  ];

  it("returns each role only when its access+secret pair is set non-empty", async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const v of ALL_VARS) env[v] = undefined;
    env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAJOHNDOECODE0EXMPL";
    env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "auditorSecretValueRealistic12345678901234";

    const { detectAvailableRoles } = await import("./init.js");
    expect(detectAvailableRoles(env)).toEqual(["operator", "auditor"]);
  });

  it("rejects whitespace-only access keys", async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const v of ALL_VARS) env[v] = undefined;
    env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "   ";
    env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const { detectAvailableRoles } = await import("./init.js");
    expect(detectAvailableRoles(env)).toEqual([]);
  });
});

// ── Story e92-u.d (non-interactive / flag matrix / TTY detection) ─────
// New flags:
//   --yes                    — skip all prompts, use defaults
//   --region <region>        — pin region, skip region prompt
//   --auto-fix <mode>        — pin mode (ask|apply|skip), skip prompt
// Non-TTY + no --yes must emit an actionable error, not block.

describe("assignee init non-interactive flags (e92-u.d)", () => {
  const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
  const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Commander's option state persists across `parseAsync` calls on the
    // same instance. Preceding test blocks invoke init with `--global`,
    // which leaves `_optionValues.global = true` set on the singleton and
    // incorrectly routes subsequent project-mode invocations through the
    // global flow. Reset the option values bag to avoid cross-test
    // contamination.
    const { initCommand } = await import("./init.js");
    // Commander exposes an internal `_optionValues` bag that holds
    // parsed flag values. Clearing it lets each test start from scratch
    // without re-importing the module (which would also drop the
    // `vi.mock` bindings set at the top of the file).
    (
      initCommand as unknown as { _optionValues: Record<string, unknown> }
    )._optionValues = {};
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-ud-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    // Tests here default to a TTY context; individual tests flip it when
    // exercising the non-TTY branch. The restore happens in afterEach.
    // Epic 94 R6: the guard now requires BOTH stdin AND stdout to be a
    // TTY (isTTY === true). Under vitest the default is `undefined` on
    // both streams, so we have to set both explicitly to simulate an
    // interactive terminal.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, "isTTY", {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("--yes --region --auto-fix apply: writes config without any prompts", async () => {
    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "eu-west-1",
      "--auto-fix",
      "apply",
    ]);

    // No prompts should have fired — wizard went straight through.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    expect(parsed["region"]).toBe("eu-west-1");
    expect(parsed["profile"]).toBe("default");
    // `apply` maps to the legacy boolean true and preferences.auto_fix = apply.
    expect(parsed["autoFixBestPractices"]).toBe(true);
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("apply");
  });

  it("--yes alone: writes config using default region / profile / env / auto-fix=ask", async () => {
    await runInitAction(["node", "init", "--yes"]);

    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;

    // detectRegion mock returns us-east-1; profile mock returns "default".
    expect(parsed["region"]).toBe("us-east-1");
    expect(parsed["profile"]).toBe("default");
    expect(parsed["autoFixBestPractices"]).toBe(false);
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
    // Environment default is "development" when --yes skips the select.
    const tags = parsed["tags"] as Record<string, string>;
    expect(tags["environment"]).toBe("development");
  });

  it("--auto-fix skip persists preferences.auto_fix=skip", async () => {
    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "us-west-2",
      "--auto-fix",
      "skip",
    ]);

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("skip");
    expect(parsed["autoFixBestPractices"]).toBe(false);
  });

  it("--auto-fix ask persists preferences.auto_fix=ask", async () => {
    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "ap-northeast-1",
      "--auto-fix",
      "ask",
    ]);

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
  });

  it("--auto-fix <invalid>: rejects with Commander validation error", async () => {
    // Route Commander's error output into a buffer so the test runner
    // doesn't print the validation noise AND we can inspect it.
    const { initCommand } = await import("./init.js");
    let errBuf = "";
    initCommand.configureOutput({
      writeErr: (s: string) => {
        errBuf += s;
      },
    });
    // Commander throws on invalid choice when exitOverride is active.
    initCommand.exitOverride();

    await expect(
      initCommand.parseAsync([
        "node",
        "init",
        "--yes",
        "--auto-fix",
        "nonsense",
      ]),
    ).rejects.toThrow();

    expect(errBuf + "").toMatch(/auto-fix|ask|apply|skip/);
  });

  it("non-TTY + no --yes: emits actionable error and exits non-zero", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });

    let errBuf = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        errBuf += String(chunk);
        return true;
      });
    // Override the global no-op exit mock with one that throws, so we
    // can assert the exit(1) happened without letting Commander's
    // action body continue past it.
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`__TEST_EXIT__:${String(code ?? "")}`);
      });

    let caughtMsg = "";
    let exitCallArgs: unknown[] = [];
    try {
      await runInitAction(["node", "init"]);
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    } finally {
      exitCallArgs = exitSpy.mock.calls[0] ?? [];
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    // The thrown marker proves process.exit was called and Commander
    // did NOT continue into the wizard.
    expect(caughtMsg).toBe("__TEST_EXIT__:1");
    expect(exitCallArgs[0]).toBe(1);
    expect(errBuf).toContain("[ERROR] init requires a TTY OR --yes flag");
    expect(errBuf).toContain("[FIX] Re-run with: assignee init --yes");

    // No prompts should have fired — we bailed before the wizard.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    // No config file should have been written.
    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  // Epic 94 R6 (D-01 regression) — the predicate must catch the
  // production case where stdin is redirected (`assignee init </dev/null`).
  // Node reports `stdin.isTTY === undefined` in that context, NOT
  // `false`, so the old `=== false` predicate silently let the wizard
  // proceed, clack aborted on the piped stdin, and `process.exit(0)`
  // fired without writing any config. This test pins the fix.
  it("R6/D-01: stdin.isTTY=undefined (piped) trips the guard with exit 1", async () => {
    // Simulate `assignee init </dev/null`: stdout still a TTY, stdin
    // is a pipe (isTTY === undefined). The vitest process.stdin default
    // IS `undefined` for isTTY, but the surrounding beforeEach set it
    // to `true`, so we explicitly clear it back here.
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let errBuf = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        errBuf += String(chunk);
        return true;
      });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`__TEST_EXIT__:${String(code ?? "")}`);
      });

    let caughtMsg = "";
    let exitCallArgs: unknown[] = [];
    try {
      await runInitAction(["node", "init"]);
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    } finally {
      exitCallArgs = exitSpy.mock.calls[0] ?? [];
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(caughtMsg).toBe("__TEST_EXIT__:1");
    expect(exitCallArgs[0]).toBe(1);
    expect(errBuf).toContain("[ERROR] init requires a TTY OR --yes flag");
    expect(errBuf).toContain("[FIX] Re-run with: assignee init --yes");
    // No prompts should have fired — we bailed before the wizard.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    // No config file should have been written.
    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  // Epic 94 R6 — symmetric coverage for the piped-stdout case
  // (e.g. `assignee init | tee log.txt`). Node also reports
  // `stdout.isTTY === undefined` for pipes, not `false`. The old
  // predicate missed this too.
  it("R6/D-01: stdout.isTTY=undefined (piped) trips the guard with exit 1", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let errBuf = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        errBuf += String(chunk);
        return true;
      });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`__TEST_EXIT__:${String(code ?? "")}`);
      });

    let caughtMsg = "";
    try {
      await runInitAction(["node", "init"]);
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(caughtMsg).toBe("__TEST_EXIT__:1");
    expect(errBuf).toContain("[ERROR] init requires a TTY OR --yes flag");
    expect(errBuf).toContain("[FIX] Re-run with: assignee init --yes");
  });

  it("non-TTY + --yes: proceeds silently with defaults (CI mode)", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
      writable: true,
    });

    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "us-east-1",
      "--auto-fix",
      "ask",
    ]);

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed["region"]).toBe("us-east-1");
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
    // No prompts fired.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
  });

  it("--yes silently overwrites existing config (no confirm prompt)", async () => {
    // Existing config present.
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      "region: old-region\n",
    );

    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "us-east-2",
      "--auto-fix",
      "ask",
    ]);

    expect(clack.confirm).not.toHaveBeenCalled();

    const content = await fs.readFile(
      path.join(configDir, "config.yaml"),
      "utf-8",
    );
    expect(content).toContain("us-east-2");
    expect(content).not.toContain("old-region");
  });

  it("interactive path unchanged when no new flags are supplied (TTY)", async () => {
    // No flags, TTY context. The existing mockPrompts() contract must
    // still be honoured — this is the non-regression guard for D-06.
    mockPrompts({
      region: "eu-central-1",
      profile: "default",
      environment: "development",
    });

    await runInitAction(["node", "init"]);

    // text (region + profile) and select (env + auto_fix) fired.
    expect(clack.text).toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalled();

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed["region"]).toBe("eu-central-1");
  });
});

// Epic 96 Wave 2 R2 (D-02 regression of Epic 94 u.d D-39).
// `init --global --yes` previously hung at the region prompt because the
// non-interactive overrides were not plumbed through to
// `promptGlobalConfig`. Only the project flow honoured `--yes` /
// `--region` / `--auto-fix`. The tests here pin the fix and guard every
// combination so the next wave cannot regress silently.
describe("assignee init --global non-interactive flags (Epic 96 W2 R2)", () => {
  let globalConfigDir: string;
  const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
  const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { initCommand } = await import("./init.js");
    (
      initCommand as unknown as { _optionValues: Record<string, unknown> }
    )._optionValues = {};
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-global-ud-test-"));
    globalConfigDir = path.join(tmpDir, ".config", "assignee");
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    vi.mocked(resolveConfigPath).mockReturnValue(
      path.join(globalConfigDir, "config.yaml"),
    );

    // Default to TTY context for the R6 non-interactive guard — tests
    // that want to exercise the piped stdin branch flip it explicitly.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, "isTTY", {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("--global --yes --region --auto-fix: no prompts, config written", async () => {
    await runInitAction([
      "node",
      "init",
      "--global",
      "--yes",
      "--region",
      "eu-west-2",
      "--auto-fix",
      "apply",
    ]);

    // CORE REGRESSION CHECK: promptGlobalConfig must NOT have issued a
    // single clack.text call. Pre-fix, the region prompt fired
    // unconditionally — a non-TTY stdin would hang the process.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();

    const configPath = path.join(globalConfigDir, "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    expect(defaults["region"]).toBe("eu-west-2");
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("apply");
  });

  it("--global --yes alone: uses DEFAULT_AWS_REGION + auto_fix=ask, no prompts", async () => {
    await runInitAction(["node", "init", "--global", "--yes"]);

    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();

    const configPath = path.join(globalConfigDir, "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    // DEFAULT_AWS_REGION baked into @assignee/core is us-east-1.
    expect(defaults["region"]).toBe("us-east-1");
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("ask");
    // No tags or naming prefix collected under --yes.
    expect(defaults["tags"]).toBeUndefined();
    expect(defaults["naming"]).toBeUndefined();
  });

  it("--global --yes silently overwrites existing config (no confirm prompt)", async () => {
    // Pre-existing config — the flow must not call clack.confirm.
    await fs.mkdir(globalConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(globalConfigDir, "config.yaml"),
      "defaults:\n  region: old-region\n",
    );

    await runInitAction([
      "node",
      "init",
      "--global",
      "--yes",
      "--region",
      "ap-south-1",
    ]);

    expect(clack.confirm).not.toHaveBeenCalled();

    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    expect(content).toContain("ap-south-1");
    expect(content).not.toContain("old-region");
  });

  it("--global with --region only (no --yes) still prompts for tags and auto-fix", async () => {
    // Non-regression guard: per-flag overrides must only skip their own
    // prompt, not the entire wizard. Region is pinned via --region, but
    // the tag loop, naming prefix, and auto-fix select still fire.
    vi.mocked(clack.text)
      .mockResolvedValueOnce("") // done with tags (first tag entry)
      .mockResolvedValueOnce(""); // no naming prefix
    vi.mocked(clack.select).mockResolvedValueOnce("skip");

    await runInitAction(["node", "init", "--global", "--region", "us-west-1"]);

    // Region prompt was skipped; tags + prefix fired (2 text calls).
    expect(vi.mocked(clack.text).mock.calls).toHaveLength(2);
    // auto-fix select fired.
    expect(vi.mocked(clack.select).mock.calls).toHaveLength(1);

    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    expect(defaults["region"]).toBe("us-west-1");
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("skip");
  });

  it("--global --auto-fix only (no --yes) still prompts for region", async () => {
    // Symmetric to the --region-only test: --auto-fix skips only the
    // auto-fix select.
    vi.mocked(clack.text)
      .mockResolvedValueOnce("ca-central-1") // region
      .mockResolvedValueOnce("") // done with tags
      .mockResolvedValueOnce(""); // no naming prefix

    await runInitAction(["node", "init", "--global", "--auto-fix", "apply"]);

    // No clack.select — auto-fix bypassed by the override.
    expect(clack.select).not.toHaveBeenCalled();
    // 3 text calls: region + tag-loop-exit + naming-prefix.
    expect(vi.mocked(clack.text).mock.calls).toHaveLength(3);

    const content = await fs.readFile(
      path.join(globalConfigDir, "config.yaml"),
      "utf-8",
    );
    const parsed = parseYaml(content) as Record<string, unknown>;
    const defaults = parsed["defaults"] as Record<string, unknown>;
    expect(defaults["region"]).toBe("ca-central-1");
    const prefs = parsed["preferences"] as Record<string, unknown>;
    expect(prefs["auto_fix"]).toBe("apply");
  });

  it("non-TTY stdin + --global --yes: does NOT hang (D-02 regression)", async () => {
    // Simulate `assignee init --global --yes --region us-east-1 </dev/null`.
    // Pre-fix this hung forever on clack.text for the region. Post-fix:
    // overrides short-circuit every prompt before clack ever opens stdin.
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    await runInitAction([
      "node",
      "init",
      "--global",
      "--yes",
      "--region",
      "us-east-1",
      "--auto-fix",
      "ask",
    ]);

    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    // Config file exists — the flow ran to completion.
    const configPath = path.join(globalConfigDir, "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    expect(content).toContain("us-east-1");
  });
});

// D-05 code-emit half: ensure init source writes `.assignee/` (hidden),
// never `./assignee/` (visible subdir). The help-text half already has
// its own guard above (describe "assignee init --help").
describe("assignee init D-05 code-emit half (e92-u.d)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { initCommand } = await import("./init.js");
    (
      initCommand as unknown as { _optionValues: Record<string, unknown> }
    )._optionValues = {};
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-d05-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes to hidden `.assignee/config.yaml`, never `./assignee/`", async () => {
    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    await runInitAction([
      "node",
      "init",
      "--yes",
      "--region",
      "us-east-1",
      "--auto-fix",
      "ask",
    ]);

    // Hidden dir exists, visible sibling does not.
    await expect(
      fs.access(path.join(tmpDir, ".assignee", "config.yaml")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, "assignee", "config.yaml")),
    ).rejects.toThrow();
  });
});

// Epic 96 Wave 2 R4 (D-05): `init --wizard` alias registration.
// `plan --wizard` and `apply --wizard` already exist; init rejecting
// the same flag with "unknown option" was a UX pothole. Tests below
// pin the flag surface + mutual-exclusivity semantics.
describe("assignee init --wizard alias (Epic 96 W2 R4)", () => {
  const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
  const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { initCommand } = await import("./init.js");
    (
      initCommand as unknown as { _optionValues: Record<string, unknown> }
    )._optionValues = {};
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "init-wizard-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });

    mockCredentials({
      detected: true,
      source: "env",
      profile: "default",
    });
    mockRegion({ region: "us-east-1" });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.defineProperty(process.stdout, "isTTY", {
      value: ORIGINAL_STDOUT_IS_TTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: ORIGINAL_STDIN_IS_TTY,
      configurable: true,
      writable: true,
    });
  });

  it("--wizard option is registered on the command", async () => {
    const { initCommand } = await import("./init.js");
    const wizardOption = initCommand.options.find(
      (opt) => opt.long === "--wizard",
    );
    expect(wizardOption?.long).toBe("--wizard");
    expect(wizardOption?.description).toMatch(/interactive wizard/i);
  });

  it("--wizard under TTY runs the same interactive flow as default init", async () => {
    // With a TTY, --wizard is a no-op signal — the wizard runs either
    // way. The test passes mocked prompt answers and asserts the
    // config is written.
    mockPrompts({
      region: "ap-southeast-1",
      profile: "default",
      environment: "development",
    });

    await runInitAction(["node", "init", "--wizard"]);

    // text (region + profile) and select (env + auto_fix) fired.
    expect(clack.text).toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalled();

    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown>;
    expect(parsed["region"]).toBe("ap-southeast-1");
  });

  it("--wizard + --yes: rejected with USAGE_ERROR (mutually exclusive)", async () => {
    // Combination is a contradiction — --wizard says "ask me"; --yes
    // says "don't ask". Must error early, never partial-apply.
    const { AssigneeError } = await import("@assignee/core");
    await expect(
      runInitAction([
        "node",
        "init",
        "--wizard",
        "--yes",
        "--region",
        "us-east-1",
      ]),
    ).rejects.toThrow(AssigneeError);

    // No prompts fired — the flow bailed before the wizard.
    expect(clack.text).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    // No config file should have been written.
    const configPath = path.join(tmpDir, ".assignee", "config.yaml");
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it("--wizard error message is actionable", async () => {
    const { AssigneeError } = await import("@assignee/core");
    try {
      await runInitAction(["node", "init", "--wizard", "--yes"]);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AssigneeError);
      const msg = (err as Error).message;
      expect(msg).toContain("--wizard");
      expect(msg).toContain("--yes");
      expect(msg).toMatch(/mutually exclusive/i);
    }
  });

  it("--wizard --global runs the global wizard interactively", async () => {
    // Symmetry check: --wizard works with --global too. The global
    // flow mocks the region/tag/prefix/auto-fix prompts like the
    // existing --global describe block does.
    vi.mocked(resolveConfigPath).mockReturnValue(
      path.join(tmpDir, ".config", "assignee", "config.yaml"),
    );
    vi.mocked(clack.text)
      .mockResolvedValueOnce("sa-east-1") // region
      .mockResolvedValueOnce("") // done with tags
      .mockResolvedValueOnce(""); // no prefix
    vi.mocked(clack.select).mockResolvedValueOnce("ask"); // auto_fix

    await runInitAction(["node", "init", "--wizard", "--global"]);

    // Prompts fired.
    expect(clack.text).toHaveBeenCalled();
    expect(clack.select).toHaveBeenCalled();

    const configPath = path.join(tmpDir, ".config", "assignee", "config.yaml");
    const content = await fs.readFile(configPath, "utf-8");
    expect(content).toContain("sa-east-1");
  });

  it("--wizard under non-TTY without --yes: hits the non-interactive guard", async () => {
    // --wizard alone doesn't bypass the TTY guard — same actionable
    // error as plain `init` when stdin is piped.
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    let errBuf = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        errBuf += String(chunk);
        return true;
      });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`__TEST_EXIT__:${String(code ?? "")}`);
      });

    let caughtMsg = "";
    try {
      await runInitAction(["node", "init", "--wizard"]);
    } catch (err) {
      caughtMsg = err instanceof Error ? err.message : String(err);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(caughtMsg).toBe("__TEST_EXIT__:1");
    expect(errBuf).toContain("[ERROR] init requires a TTY OR --yes flag");
  });

  it("--help output lists --wizard in the Options section", async () => {
    const { initCommand } = await import("./init.js");
    let captured = "";
    initCommand.outputHelp({
      write: (chunk: string) => {
        captured += chunk;
      },
    } as unknown as { error: boolean });
    expect(captured).toContain("--wizard");
    expect(captured).toMatch(/Examples:[\s\S]*--wizard/);
  });
});
