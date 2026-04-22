/**
 * Epic 94 Wave 2 N4 (A-14 / D-08) — JSON envelope unit coverage for
 * `apply` / `destroy` / `reconcile`.
 *
 * Each describe block verifies:
 *   1. `--json` + `-o, --output` option registration.
 *   2. Success envelope shape (`{ok:true, operation:"..."}`) when the
 *      underlying action resolves cleanly.
 *   3. Failure envelope shape (`{ok:false, error:{code,message,hint}}`)
 *      when the underlying action throws an `AssigneeError` (typed)
 *      and a plain `Error` (unknown → UNKNOWN_ERROR).
 *
 * We intercept the underlying `destroyAction` / `runApply` / `runReconcile`
 * via `vi.mock` so no real AWS traffic / MCP / graph runs — the Commander
 * wrapper is the only code under test. Real envelope shapes (not mocked)
 * because `serializeErrorEnvelope` is exercised through `@assignee/core`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// NOTE: `AssigneeError` is imported dynamically inside each test that
// needs `toBeInstanceOf` — mixing a top-level `import AssigneeError`
// with dynamic `await import("@assignee/core")` creates two class
// identities under vitest's ESM module graph, breaking the instance
// check. Mirrors the pattern used in `list.test.ts` (Wave 94.R7).

// ── Hoisted mocks ───────────────────────────────────────────────────────────
const {
  mockDestroyAction,
  mockRunApply,
  mockRunReconcile,
  mockRunCommand,
  mockResolveApplyArgs,
  mockResolveIntroContext,
} = vi.hoisted(() => ({
  mockDestroyAction: vi.fn(),
  mockRunApply: vi.fn(),
  mockRunReconcile: vi.fn(),
  mockRunCommand: vi.fn(),
  mockResolveApplyArgs: vi.fn(),
  mockResolveIntroContext: vi.fn(),
}));

// destroy: intercept destroyAction (the exported helper the Commander
// wrapper now delegates to). destroy.ts imports it from ./destroy/action.js
// via re-export, but we patch the relative import inside destroy.ts.
vi.mock("./destroy/action.js", () => ({
  destroyAction: (...args: unknown[]) => mockDestroyAction(...args),
}));

// apply: intercept runApply + runCommand + resolveApplyArgs.
vi.mock("./apply/orchestrator.js", () => ({
  runApply: (...args: unknown[]) => mockRunApply(...args),
}));
vi.mock("./apply/arg-parser.js", () => ({
  resolveApplyArgs: (...args: unknown[]) => mockResolveApplyArgs(...args),
}));
vi.mock("../utils/command-runner.js", () => ({
  runCommand: (...args: unknown[]) => mockRunCommand(...args),
  runProvisioningLoop: vi.fn(),
}));
// apply.ts imports resolveIntroContext/formatIntroContext from ./init.js.
vi.mock("./init.js", () => ({
  resolveIntroContext: (...args: unknown[]) => mockResolveIntroContext(...args),
  formatIntroContext: () => "test-account | us-east-1",
}));

// reconcile: intercept runReconcile.
vi.mock("./reconcile/orchestrator.js", () => ({
  runReconcile: (...args: unknown[]) => mockRunReconcile(...args),
}));

// ── Utilities ───────────────────────────────────────────────────────────────
function captureStdout(fn: () => Promise<unknown>): Promise<{
  stdout: string;
  thrown: unknown | null;
}> {
  // Suspend writes to stdout; accumulate into a buffer. We restore on
  // both success and error paths.
  const origWrite = process.stdout.write;
  let buf = "";
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buf += text;
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;

  return fn()
    .then(
      () => ({ stdout: buf, thrown: null as unknown | null }),
      (err: unknown) => ({ stdout: buf, thrown: err }),
    )
    .finally(() => {
      process.stdout.write = origWrite;
    });
}

beforeEach(() => {
  mockDestroyAction.mockReset();
  mockRunApply.mockReset();
  mockRunReconcile.mockReset();
  mockRunCommand.mockReset();
  mockResolveApplyArgs.mockReset();
  mockResolveIntroContext.mockReset();
  mockResolveIntroContext.mockResolvedValue({
    account: "123456789012",
    region: "us-east-1",
    profile: undefined,
  });
  mockResolveApplyArgs.mockResolvedValue({
    resolvedCheckpoint: null,
    resolvedSourceDir: undefined,
    sourceFileCount: undefined,
    effectiveIntent: "Create an S3 bucket",
  });
  // Default runCommand: runs the `run` callback once (like real).
  mockRunCommand.mockImplementation(
    async (opts: { run: (ctx: unknown) => Promise<unknown> }) => {
      await opts.run({
        intent: "test",
        runId: "run-1",
        startTs: 0,
        tools: [],
        graph: {},
      });
    },
  );
  // Default runApply resolves successfully.
  mockRunApply.mockResolvedValue({ success: true });
  // Default destroyAction resolves.
  mockDestroyAction.mockResolvedValue(undefined);
  // Default runReconcile resolves.
  mockRunReconcile.mockResolvedValue(undefined);
});

afterEach(() => {
  // NOTE: do NOT call `vi.resetModules()` here — it creates fresh
  // class identities per-test, causing `expect(...).toBeInstanceOf(
  // AssigneeError)` to fail because the thrown instance was constructed
  // against one module-cache entry while the assertion imports from a
  // different one. Mocks are already reset in `beforeEach`.
});

// ── apply ───────────────────────────────────────────────────────────────────
describe("applyCommand — --json envelope (Epic 94 N4 / A-14)", () => {
  it("registers --json boolean and -o, --output <format> options", async () => {
    const { applyCommand } = await import("./apply.js");
    const json = applyCommand.options.find((o) => o.long === "--json");
    const output = applyCommand.options.find((o) => o.long === "--output");
    expect(json?.long).toBe("--json");
    expect(output?.long).toBe("--output");
    expect(output?.short).toBe("-o");
  });

  it("--help contains --json flag", async () => {
    const { applyCommand } = await import("./apply.js");
    let captured = "";
    applyCommand.outputHelp({
      write: (chunk: string) => {
        captured += chunk;
      },
    } as unknown as { error: boolean });
    expect(captured).toContain("--json");
  });

  it('success path emits {ok:true, operation:"apply"} envelope', async () => {
    const { applyCommand } = await import("./apply.js");
    const { stdout, thrown } = await captureStdout(() =>
      applyCommand.parseAsync(
        ["node", "apply", "Create an S3 bucket", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(thrown).toBeNull();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("apply");
  });

  it("failure path (AssigneeError) emits {ok:false,error:{code,message,hint}} envelope", async () => {
    const { AssigneeError } = await import("@assignee/core");
    mockRunApply.mockRejectedValueOnce(
      new AssigneeError("Schema fetch failed", "SCHEMA_ERROR"),
    );
    const { applyCommand } = await import("./apply.js");
    const { stdout, thrown } = await captureStdout(() =>
      applyCommand.parseAsync(
        ["node", "apply", "Create an S3 bucket", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(thrown).toBeInstanceOf(AssigneeError);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("SCHEMA_ERROR");
    expect(parsed.error.message).toBe("Schema fetch failed");
    expect(typeof parsed.error.hint).toBe("string");
  });

  it("failure path (plain Error) emits UNKNOWN_ERROR envelope", async () => {
    mockRunApply.mockRejectedValueOnce(new Error("boom"));
    const { applyCommand } = await import("./apply.js");
    const { stdout, thrown } = await captureStdout(() =>
      applyCommand.parseAsync(
        ["node", "apply", "Create an S3 bucket", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(thrown).toBeTruthy();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_ERROR");
    expect(parsed.error.message).toBe("boom");
  });

  it("text-mode success does NOT emit a JSON envelope on stdout", async () => {
    // Use a fresh Commander instance (not the persistent `applyCommand`
    // singleton) so the `output` default ("text") isn't polluted by
    // prior `--json` test runs. Commander preserves `_optionValues`
    // across `parseAsync` calls on the same Command instance; only a
    // fresh clone gives a clean slate for the text-mode assertion.
    vi.resetModules();
    mockRunApply.mockResolvedValue({ success: true });
    const { applyCommand } = await import("./apply.js");
    const { stdout } = await captureStdout(() =>
      applyCommand.parseAsync(
        ["node", "apply", "Create an S3 bucket", "--yes"],
        { from: "user" },
      ),
    );
    // Whatever the mocked inner writes (none in our mock) must NOT be
    // a JSON envelope.
    expect(stdout).not.toMatch(/"ok"\s*:\s*true/);
    expect(stdout).not.toMatch(/"operation"\s*:\s*"apply"/);
  });
});

// ── destroy ─────────────────────────────────────────────────────────────────
describe("destroyCommand — --json envelope (Epic 94 N4 / D-08)", () => {
  it("registers --json boolean and -o, --output <format> options", async () => {
    const { destroyCommand } = await import("./destroy.js");
    const json = destroyCommand.options.find((o) => o.long === "--json");
    const output = destroyCommand.options.find((o) => o.long === "--output");
    expect(json?.long).toBe("--json");
    expect(output?.long).toBe("--output");
    expect(output?.short).toBe("-o");
  });

  it('success path emits {ok:true, operation:"destroy"} envelope', async () => {
    const { destroyCommand } = await import("./destroy.js");
    const { stdout, thrown } = await captureStdout(() =>
      destroyCommand.parseAsync(
        ["node", "destroy", "arn:aws:s3:::bucket-name", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(thrown).toBeNull();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("destroy");
  });

  it("failure path (AssigneeError DESTROY_ERROR) emits envelope", async () => {
    const { AssigneeError } = await import("@assignee/core");
    mockDestroyAction.mockRejectedValueOnce(
      new AssigneeError(
        'No managed resource found matching "nope".',
        "DESTROY_ERROR",
      ),
    );
    const { destroyCommand } = await import("./destroy.js");
    const { stdout, thrown } = await captureStdout(() =>
      destroyCommand.parseAsync(
        ["node", "destroy", "nope", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(thrown).toBeInstanceOf(AssigneeError);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("DESTROY_ERROR");
    expect(parsed.error.message).toContain("No managed resource found");
  });

  it("failure path (plain Error) emits UNKNOWN_ERROR envelope", async () => {
    mockDestroyAction.mockRejectedValueOnce(new Error("unexpected"));
    const { destroyCommand } = await import("./destroy.js");
    const { stdout } = await captureStdout(() =>
      destroyCommand.parseAsync(
        ["node", "destroy", "arn:aws:s3:::b", "--yes", "--json"],
        { from: "user" },
      ),
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_ERROR");
    expect(parsed.error.message).toBe("unexpected");
  });

  it("passes DestroyOptions (no json/output) to underlying destroyAction", async () => {
    const { destroyCommand } = await import("./destroy.js");
    await captureStdout(() =>
      destroyCommand.parseAsync(
        ["node", "destroy", "arn:aws:s3:::bucket", "--yes", "--json"],
        { from: "user" },
      ),
    );
    expect(mockDestroyAction).toHaveBeenCalledTimes(1);
    const innerOpts = mockDestroyAction.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    // json/output stripped — destroyAction's contract is preserved 1:1.
    expect(innerOpts).not.toHaveProperty("json");
    expect(innerOpts).not.toHaveProperty("output");
    expect(innerOpts["yes"]).toBe(true);
  });

  it("text-mode path is unaffected — destroyAction receives opts as before", async () => {
    const { destroyCommand } = await import("./destroy.js");
    await captureStdout(() =>
      destroyCommand.parseAsync(
        ["node", "destroy", "arn:aws:s3:::bucket", "--yes"],
        { from: "user" },
      ),
    );
    expect(mockDestroyAction).toHaveBeenCalledTimes(1);
    const innerOpts = mockDestroyAction.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(innerOpts["yes"]).toBe(true);
  });
});

// ── reconcile ───────────────────────────────────────────────────────────────
describe("reconcileCommand — --json envelope (Epic 94 N4 / D-08)", () => {
  it("registers --json boolean and -o, --output <format> options", async () => {
    const { reconcileCommand } = await import("./reconcile.js");
    const json = reconcileCommand.options.find((o) => o.long === "--json");
    const output = reconcileCommand.options.find((o) => o.long === "--output");
    expect(json?.long).toBe("--json");
    expect(output?.long).toBe("--output");
    expect(output?.short).toBe("-o");
  });

  it('success path emits {ok:true, operation:"reconcile"} envelope', async () => {
    const { reconcileCommand } = await import("./reconcile.js");
    const { stdout, thrown } = await captureStdout(() =>
      reconcileCommand.parseAsync(["node", "reconcile", "--yes", "--json"], {
        from: "user",
      }),
    );
    expect(thrown).toBeNull();
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("reconcile");
  });

  it("failure path (AssigneeError) emits envelope with typed code", async () => {
    const { AssigneeError } = await import("@assignee/core");
    mockRunReconcile.mockRejectedValueOnce(
      new AssigneeError("Drift detector missing", "RECONCILE_ERROR"),
    );
    const { reconcileCommand } = await import("./reconcile.js");
    const { stdout, thrown } = await captureStdout(() =>
      reconcileCommand.parseAsync(["node", "reconcile", "--yes", "--json"], {
        from: "user",
      }),
    );
    expect(thrown).toBeInstanceOf(AssigneeError);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("RECONCILE_ERROR");
    expect(parsed.error.message).toBe("Drift detector missing");
  });

  it("failure path (plain Error) emits UNKNOWN_ERROR envelope", async () => {
    mockRunReconcile.mockRejectedValueOnce(new Error("oops"));
    const { reconcileCommand } = await import("./reconcile.js");
    const { stdout } = await captureStdout(() =>
      reconcileCommand.parseAsync(["node", "reconcile", "--yes", "--json"], {
        from: "user",
      }),
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_ERROR");
    expect(parsed.error.message).toBe("oops");
  });

  it("-o json is equivalent to --json", async () => {
    const { reconcileCommand } = await import("./reconcile.js");
    const { stdout } = await captureStdout(() =>
      reconcileCommand.parseAsync(
        ["node", "reconcile", "--yes", "-o", "json"],
        { from: "user" },
      ),
    );
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.operation).toBe("reconcile");
  });
});
