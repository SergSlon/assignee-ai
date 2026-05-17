import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(original.existsSync),
    mkdirSync: vi.fn(() => undefined),
  };
});

const mockedFs = vi.mocked(fs);

// Import AFTER mock setup
import {
  isFirstRun,
  ensureAssigneeHome,
  showFirstRunWelcome,
  bootstrapFirstRun,
  detectCredentialStatus,
  ASSIGNEE_HOME,
} from "./first-run.js";

describe("first-run", () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("isFirstRun", () => {
    it("returns true when ~/.assignee does not exist", () => {
      mockedFs.existsSync.mockReturnValue(false);
      expect(isFirstRun()).toBe(true);
    });

    it("returns false when ~/.assignee exists", () => {
      mockedFs.existsSync.mockReturnValue(true);
      expect(isFirstRun()).toBe(false);
    });

    it("returns true when existsSync throws", () => {
      mockedFs.existsSync.mockImplementation(() => {
        throw new Error("permission denied");
      });
      expect(isFirstRun()).toBe(true);
    });
  });

  describe("ensureAssigneeHome", () => {
    it("creates ~/.assignee/memory directory recursively", () => {
      ensureAssigneeHome();
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("memory"),
        { recursive: true },
      );
    });

    it("does not throw when mkdir fails", () => {
      mockedFs.mkdirSync.mockImplementation(() => {
        throw new Error("read-only filesystem");
      });
      expect(() => ensureAssigneeHome()).not.toThrow();
    });
  });

  describe("detectCredentialStatus", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns operator status when ASSIGNEE_OPERATOR_* vars are set", () => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "op-key");
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", "op-secret");
      const result = detectCredentialStatus();
      expect(result.status).toBe("operator");
      expect(result.hint).toContain("ASSIGNEE_OPERATOR_*");
    });

    it("returns standard status when AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set", () => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "");
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI");
      const result = detectCredentialStatus();
      expect(result.status).toBe("standard");
    });

    it("returns profile status with correct hint when AWS_PROFILE is set", () => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "");
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_PROFILE", "my-profile");
      const result = detectCredentialStatus();
      expect(result.status).toBe("profile");
      // Hint must reference the profile name
      expect(result.hint).toContain("my-profile");
      // Hint must NOT claim the profile is unsupported
      expect(result.hint).not.toContain("not supported");
      // Hint must NOT instruct user to export raw keys
      expect(result.hint).not.toContain("export AWS_ACCESS_KEY_ID");
      // Hint must reference the standard credential chain
      expect(result.hint).toContain("credential chain");
    });

    it("returns none status when no credentials are set", () => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "");
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
      vi.stubEnv("AWS_PROFILE", "");
      const result = detectCredentialStatus();
      expect(result.status).toBe("none");
    });

    it("hint strings for all 4 status values are ASCII-only (no Unicode above U+007E)", () => {
      const asciiOnly = /^[\x20-\x7E]*$/;

      // operator
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "op-key");
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", "op-secret");
      expect(detectCredentialStatus().hint).toMatch(asciiOnly);
      vi.unstubAllEnvs();

      // standard
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI");
      expect(detectCredentialStatus().hint).toMatch(asciiOnly);
      vi.unstubAllEnvs();

      // profile
      vi.stubEnv("AWS_PROFILE", "my-dev-profile");
      expect(detectCredentialStatus().hint).toMatch(asciiOnly);
      vi.unstubAllEnvs();

      // none (no env vars)
      expect(detectCredentialStatus().hint).toMatch(asciiOnly);
    });
  });

  describe("showFirstRunWelcome", () => {
    it("writes guided welcome to stderr when TTY (contains version and next steps)", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true,
      });

      showFirstRunWelcome("0.1.0");

      const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      // Should contain the version
      expect(allOutput).toContain("Assignee.ai v0.1.0");
      // Should include credential detection or next-steps guidance
      // Story 108-A-05: `assignee plan` → `assignee infra plan`
      expect(allOutput).toMatch(
        /credentials|assignee infra plan|AWS_ACCESS_KEY_ID/,
      );
      // Story 50-2 / 50-3: the `patterns` + `types` standalone commands were
      // removed; their content is now folded into `plan --help`. The welcome
      // message should point users at that unified entrypoint.
      // Story 108-A-05: path is now noun-grouped `assignee infra plan --help`.
      expect(allOutput).toContain("assignee infra plan --help");

      Object.defineProperty(process.stderr, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    });

    it("writes minimal message when not TTY (plain one-liner)", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });

      showFirstRunWelcome("0.1.0");

      // Non-TTY path writes a simple one-liner with version, no ANSI codes
      // Tier C: dropped redundant toBeDefined() — find!() at the find site
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const welcomeCall = calls.find((c) => c.includes("Assignee v"))!;
      expect(welcomeCall).toContain("0.1.0");
      // Should NOT contain ANSI escape codes in non-TTY mode
      expect(welcomeCall).not.toContain("\u001B[");

      Object.defineProperty(process.stderr, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    });

    it("non-TTY output is ASCII-only (no characters outside 0x20-0x7E)", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });

      showFirstRunWelcome("0.1.0");

      const allOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      // Allow printable ASCII + newlines; reject any character outside that range
      expect(allOutput).toMatch(/^[\x20-\x7E\n]*$/);

      Object.defineProperty(process.stderr, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    });

    it("status=none setup section includes both export and $Env: snippets", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true,
      });
      // Ensure no credentials are set so status === "none"
      const origAccessKey = process.env["AWS_ACCESS_KEY_ID"];
      const origSecretKey = process.env["AWS_SECRET_ACCESS_KEY"];
      const origProfile = process.env["AWS_PROFILE"];
      const origOpKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      const origOpSecret = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      delete process.env["AWS_ACCESS_KEY_ID"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
      delete process.env["AWS_PROFILE"];
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

      try {
        showFirstRunWelcome("0.1.0");

        const allOutput = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .join("");
        // Must contain POSIX export syntax
        expect(allOutput).toContain("export AWS_ACCESS_KEY_ID");
        // Must contain PowerShell $Env: syntax
        expect(allOutput).toContain("$Env:AWS_ACCESS_KEY_ID");
      } finally {
        if (origAccessKey !== undefined)
          process.env["AWS_ACCESS_KEY_ID"] = origAccessKey;
        if (origSecretKey !== undefined)
          process.env["AWS_SECRET_ACCESS_KEY"] = origSecretKey;
        if (origProfile !== undefined) process.env["AWS_PROFILE"] = origProfile;
        if (origOpKey !== undefined)
          process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = origOpKey;
        if (origOpSecret !== undefined)
          process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = origOpSecret;
        Object.defineProperty(process.stderr, "isTTY", {
          value: origIsTTY,
          configurable: true,
        });
      }
    });

    // Story 50-2: chalk@5 honors NO_COLOR natively — the TTY welcome path
    // MUST emit zero ANSI escape sequences when NO_COLOR is set, even when
    // stderr reports as a TTY. chalk's colour detection runs at module load,
    // so force chalk.level = 0 for the duration of the test to simulate the
    // native behavior.
    it("honors NO_COLOR — emits zero ANSI escape codes even in TTY", async () => {
      const chalkMod = await import("chalk");
      const originalLevel = chalkMod.default.level;
      chalkMod.default.level = 0;

      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true,
      });

      try {
        showFirstRunWelcome("0.1.0");

        const allOutput = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .join("");

        // No ANSI CSI sequences anywhere in the rendered welcome.
        expect(allOutput).not.toContain("\u001B[");
        // Content still renders (just plain text now).
        expect(allOutput).toContain("Assignee.ai v0.1.0");
        // Story 108-A-05: path is now noun-grouped `assignee infra plan --help`.
        expect(allOutput).toContain("assignee infra plan --help");
      } finally {
        chalkMod.default.level = originalLevel;
        Object.defineProperty(process.stderr, "isTTY", {
          value: origIsTTY,
          configurable: true,
        });
      }
    });
  });

  describe("bootstrapFirstRun", () => {
    it("returns true and creates dir on first run", () => {
      mockedFs.existsSync.mockReturnValue(false);
      const result = bootstrapFirstRun("0.1.0");
      expect(result).toBe(true);
      expect(mockedFs.mkdirSync).toHaveBeenCalled();
    });

    it("returns false and does nothing when ~/.assignee exists", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.mkdirSync.mockClear();
      const result = bootstrapFirstRun("0.1.0");
      expect(result).toBe(false);
      expect(mockedFs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe("ASSIGNEE_HOME", () => {
    it("points to ~/.assignee", () => {
      expect(ASSIGNEE_HOME).toContain(".assignee");
    });
  });
});
