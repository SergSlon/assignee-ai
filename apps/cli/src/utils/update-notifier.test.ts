import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the underlying `update-notifier` package. Using `vi.hoisted` so
// the mock function is created before the module factory runs.
const { notifyMock, updateNotifierMock } = vi.hoisted(() => {
  const notifyMock = vi.fn();
  const updateNotifierMock = vi.fn(() => ({ notify: notifyMock }));
  return { notifyMock, updateNotifierMock };
});

vi.mock("update-notifier", () => ({
  default: updateNotifierMock,
}));

// Import AFTER mock setup so the wrapper picks up the mocked module.
import {
  checkForUpdates,
  shouldSuppressUpdateCheck,
  type NotifierPkg,
} from "./update-notifier.js";

// Real package identity — mirrors apps/cli/package.json so the test
// reflects production call-shape (Rule: all mocks use real data).
const PKG: NotifierPkg = {
  name: "assignee",
  version: "0.1.0",
};

describe("shouldSuppressUpdateCheck", () => {
  it("returns false in an interactive TTY with no suppressing flags", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan", "--verbose"],
      {},
      true,
    );
    expect(result).toBe(false);
  });

  it("returns true when ASSIGNEE_NO_UPDATE_CHECK=1", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { ASSIGNEE_NO_UPDATE_CHECK: "1" },
      true,
    );
    expect(result).toBe(true);
  });

  it("does NOT suppress when ASSIGNEE_NO_UPDATE_CHECK is unrelated value", () => {
    // Only "1" is the documented opt-out — "true" / "0" / "" stay active
    // so users cannot be accidentally opted out by stale env vars.
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { ASSIGNEE_NO_UPDATE_CHECK: "true" },
      true,
    );
    expect(result).toBe(false);
  });

  it("returns true when CI=true", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { CI: "true" },
      true,
    );
    expect(result).toBe(true);
  });

  it("returns true when CI=1 (GitHub Actions style)", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { CI: "1" },
      true,
    );
    expect(result).toBe(true);
  });

  it("does NOT suppress when CI='false' (explicit opt-in for local work)", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { CI: "false" },
      true,
    );
    expect(result).toBe(false);
  });

  it("does NOT suppress when CI='0'", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      { CI: "0" },
      true,
    );
    expect(result).toBe(false);
  });

  it("returns true when stdout is not a TTY (piped / redirected)", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan"],
      {},
      false,
    );
    expect(result).toBe(true);
  });

  it("returns true when --json is in argv", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan", "--json"],
      {},
      true,
    );
    expect(result).toBe(true);
  });

  it("returns true when `-o json` (two tokens) is in argv", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan", "-o", "json"],
      {},
      true,
    );
    expect(result).toBe(true);
  });

  it("returns true when `--output json` (two tokens) is in argv", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "status", "--output", "json"],
      {},
      true,
    );
    expect(result).toBe(true);
  });

  it("returns true when `--output=json` (joined form) is in argv", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "status", "--output=json"],
      {},
      true,
    );
    expect(result).toBe(true);
  });

  it("does NOT match `--jsonify` or similar prefixes as false positives", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan", "--jsonify", "--output-json-path", "out"],
      {},
      true,
    );
    expect(result).toBe(false);
  });

  it("does NOT match `-o yaml` — only `json` values trigger suppression", () => {
    const result = shouldSuppressUpdateCheck(
      ["node", "assignee", "plan", "-o", "yaml"],
      {},
      true,
    );
    expect(result).toBe(false);
  });
});

describe("checkForUpdates", () => {
  beforeEach(() => {
    updateNotifierMock.mockClear();
    notifyMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes updateNotifier and .notify() when conditions are permissive", () => {
    checkForUpdates(PKG, ["node", "assignee", "plan"], {}, true);

    expect(updateNotifierMock).toHaveBeenCalledTimes(1);
    expect(updateNotifierMock).toHaveBeenCalledWith({
      pkg: PKG,
      updateCheckInterval: 1000 * 60 * 60 * 24,
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({ defer: true, isGlobal: true });
  });

  it("skips the check entirely when ASSIGNEE_NO_UPDATE_CHECK=1", () => {
    checkForUpdates(
      PKG,
      ["node", "assignee", "plan"],
      { ASSIGNEE_NO_UPDATE_CHECK: "1" },
      true,
    );

    expect(updateNotifierMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("skips the check entirely when CI=true", () => {
    checkForUpdates(PKG, ["node", "assignee", "plan"], { CI: "true" }, true);

    expect(updateNotifierMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("skips the check entirely when stdout is not a TTY", () => {
    checkForUpdates(PKG, ["node", "assignee", "plan"], {}, false);

    expect(updateNotifierMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("skips the check entirely when --json is in argv", () => {
    checkForUpdates(PKG, ["node", "assignee", "plan", "--json"], {}, true);

    expect(updateNotifierMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("skips the check entirely when `-o json` is in argv", () => {
    checkForUpdates(PKG, ["node", "assignee", "plan", "-o", "json"], {}, true);

    expect(updateNotifierMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by updateNotifier itself (registry unreachable)", () => {
    updateNotifierMock.mockImplementationOnce(() => {
      throw new Error("ENOTFOUND registry.npmjs.org");
    });

    expect(() =>
      checkForUpdates(PKG, ["node", "assignee", "plan"], {}, true),
    ).not.toThrow();

    expect(updateNotifierMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("swallows errors thrown inside .notify()", () => {
    notifyMock.mockImplementationOnce(() => {
      throw new Error("configstore write failed");
    });

    expect(() =>
      checkForUpdates(PKG, ["node", "assignee", "plan"], {}, true),
    ).not.toThrow();

    expect(updateNotifierMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
