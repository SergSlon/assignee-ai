/**
 * Tests for display-findings.ts — formatMemoryHints TTY/non-TTY behaviour.
 *
 * P076: ANSI-escape codes must never appear in formatMemoryHints output
 * when stdout is not a TTY (e.g. piped to `jq` or captured in CI).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Pattern matching any CSI/ANSI escape sequence (colour, bold, dim, reset). */
const ANSI_RE = /\x1b\[[0-9;]*m/;

async function setTty(value: boolean | undefined) {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
    writable: true,
  });
}

async function setChalkLevel(level: 0 | 1 | 2 | 3) {
  const chalkMod = await import("chalk");
  chalkMod.default.level = level;
}

// ─── formatMemoryHints — edge cases ─────────────────────────────────────────

describe("formatMemoryHints — null/empty guard", () => {
  it("returns null for undefined hints", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    expect(formatMemoryHints(undefined)).toBeNull();
  });

  it("returns null for empty array", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    expect(formatMemoryHints([])).toBeNull();
  });
});

// ─── formatMemoryHints — non-TTY (pipe / CI) ────────────────────────────────

describe("formatMemoryHints — non-TTY mode (piped output)", () => {
  let originalIsTTY: boolean | undefined;
  let originalChalkLevel: 0 | 1 | 2 | 3;

  beforeEach(async () => {
    originalIsTTY = process.stdout.isTTY as boolean | undefined;
    const chalkMod = await import("chalk");
    originalChalkLevel = chalkMod.default.level as 0 | 1 | 2 | 3;

    await setTty(false);
    await setChalkLevel(0);
  });

  afterEach(async () => {
    await setTty(originalIsTTY);
    await setChalkLevel(originalChalkLevel);
  });

  it("cost hint — emits plain text with 'Cost History:' label, zero ANSI codes", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    const result = formatMemoryHints(["Previous provision: $0.50/mo avg"]);

    expect(result).not.toBeNull();
    expect(result).toContain("Cost History:");
    expect(result).toContain("Previous provision: $0.50/mo avg");
    expect(result).not.toMatch(ANSI_RE);
  });

  it("warning hint (⚠ prefix) — emits plain text with 'Warning:' label, zero ANSI codes", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    const result = formatMemoryHints([
      "⚠ Previous error with AWS::S3::Bucket: NoSuchBucket.",
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain("Warning:");
    expect(result).toContain("Previous error with AWS::S3::Bucket");
    // ⚠ prefix must be stripped from the body text
    expect(result).not.toContain("⚠");
    expect(result).not.toMatch(ANSI_RE);
  });

  it("mixed cost + warning hints — both lines plain text, zero ANSI codes", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    const result = formatMemoryHints([
      "Previous provision: $1.20/mo avg",
      "⚠ Previous error with AWS::Lambda::Function: throttled.",
    ]);

    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Cost History:");
    expect(lines[1]).toContain("Warning:");
    expect(result).not.toMatch(ANSI_RE);
  });

  it("warning hint with variation-selector (⚠️) stripped correctly in non-TTY", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    // U+26A0 followed by U+FE0F (variation selector-16 — emoji form)
    const result = formatMemoryHints(["⚠️ Error occurred."]);

    expect(result).not.toBeNull();
    expect(result).toContain("Warning:");
    expect(result).toContain("Error occurred.");
    expect(result).not.toContain("⚠");
    expect(result).not.toContain("️");
    expect(result).not.toMatch(ANSI_RE);
  });
});

// ─── formatMemoryHints — TTY mode (interactive terminal) ─────────────────────

describe("formatMemoryHints — TTY mode (interactive terminal)", () => {
  let originalIsTTY: boolean | undefined;
  let originalChalkLevel: 0 | 1 | 2 | 3;

  beforeEach(async () => {
    originalIsTTY = process.stdout.isTTY as boolean | undefined;
    const chalkMod = await import("chalk");
    originalChalkLevel = chalkMod.default.level as 0 | 1 | 2 | 3;

    await setTty(true);
    await setChalkLevel(1);
  });

  afterEach(async () => {
    await setTty(originalIsTTY);
    await setChalkLevel(originalChalkLevel);
  });

  it("cost hint — output contains ANSI codes (chalk.dim applied)", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    const result = formatMemoryHints(["Previous provision: $0.50/mo avg"]);

    expect(result).not.toBeNull();
    expect(result).toContain("Cost History:");
    expect(result).toContain("Previous provision: $0.50/mo avg");
    // chalk.dim emits ANSI dim/reset sequences when level >= 1
    expect(result).toMatch(ANSI_RE);
  });

  it("warning hint — output contains ANSI codes (chalk.yellow applied)", async () => {
    const { formatMemoryHints } = await import("./display-findings.js");
    const result = formatMemoryHints([
      "⚠ Previous error with AWS::EC2::Instance: quota exceeded.",
    ]);

    expect(result).not.toBeNull();
    expect(result).toContain("Warning:");
    expect(result).toContain("Previous error with AWS::EC2::Instance");
    expect(result).not.toContain("⚠");
    // chalk.yellow emits ANSI colour sequences when level >= 1
    expect(result).toMatch(ANSI_RE);
  });
});
