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

  describe("showFirstRunWelcome", () => {
    it("writes welcome message to stderr when TTY", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        configurable: true,
      });

      showFirstRunWelcome("0.1.0");

      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Assignee v0.1.0"),
      );

      Object.defineProperty(process.stderr, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    });

    it("does not write to stderr when not TTY", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });

      showFirstRunWelcome("0.1.0");

      // stderrSpy may have been called by logger during module import, check the specific message
      const calls = stderrSpy.mock.calls.map((c) => c[0]);
      const welcomeCalls = calls.filter(
        (c: unknown) =>
          typeof c === "string" && (c as string).includes("Assignee"),
      );
      expect(welcomeCalls).toHaveLength(0);

      Object.defineProperty(process.stderr, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
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
