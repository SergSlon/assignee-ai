/**
 * Unit tests for the JSON-mode stderr filter — Epic 96 Wave 3 N4 (D-04).
 *
 * The filter drops writes whose first non-ANSI byte sequence starts
 * with one of the `renderError` prefixes (`[ERROR] `, `[CONTEXT] `,
 * `[FIX] `, plus the chalk-TTY variants `\u2716 Error:`, `  Why:`,
 * `  How to Fix:`). Structured log lines and any other stderr writes
 * pass through unchanged.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { installJsonStderrFilter } from "./json-stderr-filter.js";

// Capture stderr writes into a buffer while restoring on teardown.
let captured: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);

function startCapture(): void {
  captured = [];
  process.stderr.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    captured.push(text);
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stderr.write;
}

function stopCapture(): void {
  process.stderr.write = origWrite;
}

afterEach(() => {
  stopCapture();
  vi.restoreAllMocks();
});

describe("installJsonStderrFilter — disabled mode", () => {
  it("returns a no-op restore when enabled=false", () => {
    const { restore } = installJsonStderrFilter(false);
    expect(typeof restore).toBe("function");
    // Calling restore on the no-op is safe.
    expect(() => restore()).not.toThrow();
  });

  it("does NOT alter process.stderr.write when enabled=false", () => {
    const before = process.stderr.write;
    const { restore } = installJsonStderrFilter(false);
    expect(process.stderr.write).toBe(before);
    restore();
    expect(process.stderr.write).toBe(before);
  });
});

describe("installJsonStderrFilter — enabled mode", () => {
  it("drops [ERROR] ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write(
        "[ERROR] The requested resource type is not supported.\n",
      );
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops [CONTEXT] ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("[CONTEXT] Some context line.\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops [FIX] ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("[FIX] Run `assignee plan --help`.\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops TTY-style ✖ Error: ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("\u2716 Error: boom\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops TTY-style '  Why:' ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("  Why: context line\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops TTY-style '  How to Fix:' ... writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("  How to Fix: run `assignee --verbose plan`\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("drops writes even when leading ANSI colour codes are present", () => {
    // chalk.red("[ERROR] ...") style prefix — the SGR escape must not
    // defeat the matcher.
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("\u001b[31m[ERROR] colourised error\u001b[0m\n");
      process.stderr.write("\u001b[1;33m  Why: colourised context\u001b[0m\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toEqual([]);
  });

  it("PASSES THROUGH structured JSON log lines (most important case)", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write(
        '{"ts":"2026-04-23T09:00:00.000Z","runId":"abc","level":"info","action":"plan_started"}\n',
      );
      process.stderr.write(
        '{"ts":"2026-04-23T09:00:01.000Z","level":"error","action":"apply_failed"}\n',
      );
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain('"action":"plan_started"');
    expect(captured[1]).toContain('"action":"apply_failed"');
  });

  it("PASSES THROUGH arbitrary non-error-prefix writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("Connecting to AWS...\n");
      process.stderr.write("Provisioning resource 1 of 3...\n");
      process.stderr.write("assignee apply  [region=us-east-1]\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe("Connecting to AWS...\n");
    expect(captured[1]).toBe("Provisioning resource 1 of 3...\n");
    expect(captured[2]).toBe("assignee apply  [region=us-east-1]\n");
  });

  it("passes Buffer writes through the same decoder", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      // renderError writes strings; a defensive path tests Buffer too.
      process.stderr.write(Buffer.from("[ERROR] buffer error\n", "utf8"));
      process.stderr.write(Buffer.from("legitimate log\n", "utf8"));
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe("legitimate log\n");
  });

  it("invokes the optional write callback for dropped writes", () => {
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    const cb = vi.fn();
    try {
      process.stderr.write("[ERROR] foo\n", cb);
    } finally {
      restore();
    }
    stopCapture();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("restore() is idempotent — second call is a no-op", () => {
    const before = process.stderr.write;
    const { restore } = installJsonStderrFilter(true);
    // stderr.write was replaced.
    expect(process.stderr.write).not.toBe(before);
    restore();
    expect(process.stderr.write).toBe(before);
    // Second restore must not blow up and must not re-replace.
    restore();
    expect(process.stderr.write).toBe(before);
  });

  it("restore() puts back the EXACT original function identity", () => {
    // Test harnesses that spy on process.stderr.write by identity
    // depend on this — a `.bind(...)` wrapper would break the spy.
    const before = process.stderr.write;
    const { restore } = installJsonStderrFilter(true);
    restore();
    expect(process.stderr.write).toBe(before);
  });
});

describe("installJsonStderrFilter — prefix matching precision", () => {
  it("does NOT drop writes that merely contain '[ERROR]' later in the line", () => {
    // Only LEADING prefix counts. A stdout-like log line that mentions
    // `[ERROR]` mid-sentence must still pass through.
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write(
        'Parsed log: event="[ERROR] remote service failure"\n',
      );
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("[ERROR]");
  });

  it("requires the trailing space after [ERROR] — '[ERROR]' alone at EOL passes through", () => {
    // The renderError contract is `[ERROR] <message>\n` with a space.
    // A write of `[ERROR]\n` (no space) is not a renderError output
    // and should pass through to avoid over-filtering.
    startCapture();
    const { restore } = installJsonStderrFilter(true);
    try {
      process.stderr.write("[ERROR]\n");
    } finally {
      restore();
    }
    stopCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe("[ERROR]\n");
  });
});
