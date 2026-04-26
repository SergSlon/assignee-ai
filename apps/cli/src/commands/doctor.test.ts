/**
 * Tests for `assignee doctor`.
 *
 * Strategy:
 * - Each top-level check is exercised in isolation with injected deps so we
 *   can simulate every status branch (ok / warn / fail) without going to AWS.
 * - The orchestrator (`runDoctor`) is exercised end-to-end with `skipBedrock`
 *   and `skipMcp` so the test suite stays hermetic and CI-friendly with no
 *   AWS credentials.
 * - Cache, config, and best-practices checks are exercised against real
 *   files in temp directories — no fs mocking — to catch path/format
 *   regressions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  checkCredentials,
  checkBedrock,
  checkMcpServers,
  checkCache,
  checkConfig,
  checkBestPractices,
  runDoctor,
  runShortDoctor,
  renderReport,
  renderSection,
  type DoctorReport,
} from "./doctor.js";

const ENV_KEYS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_LLM_DEFAULT",
  "ASSIGNEE_MODEL",
  "BEDROCK_GUARDRAIL_ID",
  "BEDROCK_GUARDRAIL_VERSION",
  "BEDROCK_GUARDRAIL_DISABLE",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── Credentials check ─────────────────────────────────────────────────────

describe("checkCredentials", () => {
  it("reports operator as fail when no env vars are set", async () => {
    const section = await checkCredentials({
      stsClientFactory: () => ({ send: vi.fn() }),
    });
    expect(section.name).toBe("Credentials");
    expect(section.status).toBe("fail");
    const operator = section.subs.find((s) => s.label.trim() === "operator");
    expect(operator?.status).toBe("fail");
    expect(operator?.detail).toContain("not set");
    // reader/auditor are warn (not strictly required to plan).
    const reader = section.subs.find((s) => s.label.trim() === "reader");
    expect(reader?.status).toBe("warn");
  });

  it("calls STS for each role with credentials and reports ok with the resolved ARN", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Account: "111111111111",
        Arn: "arn:aws:iam::111111111111:user/assignee-operator",
      })
      .mockResolvedValueOnce({
        Account: "111111111111",
        Arn: "arn:aws:iam::111111111111:user/assignee-reader",
      })
      .mockResolvedValueOnce({
        Account: "111111111111",
        Arn: "arn:aws:iam::111111111111:user/assignee-auditor",
      });

    const factory = vi.fn().mockReturnValue({ send });
    const section = await checkCredentials({ stsClientFactory: factory });

    expect(section.status).toBe("ok");
    expect(section.subs).toHaveLength(3);
    for (const sub of section.subs) {
      expect(sub.status).toBe("ok");
      expect(sub.detail).toContain("arn:aws:iam::111111111111:user/assignee-");
      // Mask shows prefix only — never the full key.
      expect(sub.detail).toContain("AKIA");
      expect(sub.detail).not.toContain("FODNN7EXAMPLE");
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledWith(expect.any(GetCallerIdentityCommand));
  });

  it("reports fail when STS rejects for a credentialed role", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const section = await checkCredentials({
      stsClientFactory: () => ({
        send: vi.fn().mockRejectedValue(new Error("InvalidClientTokenId")),
      }),
    });
    expect(section.status).toBe("fail");
    const operator = section.subs.find((s) => s.label.trim() === "operator");
    expect(operator?.status).toBe("fail");
    expect(operator?.detail).toContain("InvalidClientTokenId");
  });

  it("reports fail when STS returns an empty identity payload", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const section = await checkCredentials({
      stsClientFactory: () => ({
        // Intentionally empty identity body: production branches on
        // `!result.Account || !result.Arn`. We keep Account/Arn absent
        // (that's the test signal) but attach a realistic $metadata
        // envelope so the mock matches the real SDK response shape —
        // GetCallerIdentity always returns $metadata even when the
        // payload is empty.
        send: vi.fn().mockResolvedValue({
          $metadata: {
            httpStatusCode: 200,
            requestId: "test-req-sts-empty-identity",
            attempts: 1,
            totalRetryDelay: 0,
          },
        }),
      }),
    });
    const operator = section.subs.find((s) => s.label.trim() === "operator");
    expect(operator?.status).toBe("fail");
    expect(operator?.detail).toContain("empty identity");
  });

  it("warns when an access key has an unusual shape (no STS call attempted)", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "not-a-real-key";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "secret";
    const send = vi.fn();
    const section = await checkCredentials({
      stsClientFactory: () => ({ send }),
    });
    const operator = section.subs.find((s) => s.label.trim() === "operator");
    expect(operator?.status).toBe("warn");
    expect(operator?.detail).toContain("access key shape unusual");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not leak the per-check timeout timer after a successful STS call (EX-7 regression)", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    vi.useFakeTimers();
    try {
      const send = vi.fn().mockResolvedValue({
        Account: "111111111111",
        Arn: "arn:aws:iam::111111111111:user/assignee-x",
      });
      const section = await checkCredentials({
        stsClientFactory: () => ({ send }),
      });
      expect(section.status).toBe("ok");
      // Regression: before the fix, withTimeout left three live timers
      // (one per role) pinned to the event loop for DEFAULT_CHECK_TIMEOUT_MS.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leak the per-check timeout timer when STS rejects (EX-7 regression)", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    vi.useFakeTimers();
    try {
      const section = await checkCredentials({
        stsClientFactory: () => ({
          send: vi.fn().mockRejectedValue(new Error("InvalidClientTokenId")),
        }),
      });
      expect(section.status).toBe("fail");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out STS calls that exceed the per-check budget", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const section = await checkCredentials({
      timeoutMs: 25,
      stsClientFactory: () => ({
        send: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ Account: "1", Arn: "arn:aws:iam::1:user/x" }),
              500,
            ),
          ),
      }),
    });
    const operator = section.subs.find((s) => s.label.trim() === "operator");
    expect(operator?.status).toBe("fail");
    expect(operator?.detail).toContain("timed out");
  });
});

// ── Bedrock check ─────────────────────────────────────────────────────────

describe("checkBedrock", () => {
  it("reports ok when the LLM adapter returns text", async () => {
    // R8-03 (P018): the new Guardrail HIGH sub-check fires by default
    // when BEDROCK_GUARDRAIL_ID is unset. This test isolates the LLM
    // adapter's healthy-path assertion from that check by signalling
    // operator-accepted-risk via BEDROCK_GUARDRAIL_DISABLE=1. The
    // Guardrail check itself has dedicated coverage in
    // doctor/checks/bedrock.test.ts.
    process.env["BEDROCK_GUARDRAIL_DISABLE"] = "1";
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi
          .fn()
          .mockResolvedValue([null, "Hello! How can I help?"] as const),
      }),
    });
    expect(section.status).toBe("ok");
    expect(section.subs[0]?.status).toBe("ok");
    expect(section.subs[0]?.detail).toContain("responded");
  });

  it("reports warn when the LLM returns an empty string", async () => {
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi.fn().mockResolvedValue([null, ""] as const),
      }),
    });
    expect(section.status).toBe("warn");
    expect(section.subs[0]?.status).toBe("warn");
    expect(section.subs[0]?.detail).toContain("empty response");
  });

  it("reports fail when the LLM adapter returns an error tuple", async () => {
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi
          .fn()
          .mockResolvedValue([
            new Error("AccessDeniedException"),
            null,
          ] as const),
      }),
    });
    expect(section.status).toBe("fail");
    expect(section.subs[0]?.detail).toContain("AccessDeniedException");
  });

  it("reports fail when the LLM call times out", async () => {
    const section = await checkBedrock({
      timeoutMs: 25,
      llmFactory: () => ({
        generateText: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve([null, "late"] as const), 500),
          ),
      }),
    });
    expect(section.status).toBe("fail");
    expect(section.subs[0]?.detail).toContain("timed out");
  });

  it("reports fail without invoking the LLM when bedrock provider has no operator creds", async () => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "bedrock/amazon.nova-lite-v1:0";
    // No llmFactory injected — the production guard fires and short-circuits
    // before any provider package is loaded.
    const section = await checkBedrock();
    expect(section.status).toBe("fail");
    expect(section.subs[0]?.detail).toContain("operator credentials required");
  });

  it("includes the configured guardrail in the section name and adds a guardrail sub-check", async () => {
    process.env["BEDROCK_GUARDRAIL_ID"] = "abc123";
    process.env["BEDROCK_GUARDRAIL_VERSION"] = "DRAFT";
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi.fn().mockResolvedValue([null, "ok"] as const),
      }),
    });
    expect(section.name).toContain("guardrail abc123:DRAFT");
    const guardrailSub = section.subs.find((s) => s.label === "Guardrail");
    expect(guardrailSub?.status).toBe("ok");
    expect(guardrailSub?.detail).toContain("abc123:DRAFT");
  });

  // Tier S #2: pre-fix the doctor header always showed BEDROCK_MODEL_ID
  // (the default model) even when ASSIGNEE_LLM_DEFAULT was set to override it.
  // Observed in 2026-04-08 live smoke when forcing the Wave 12 region-error
  // hint via `ASSIGNEE_LLM_DEFAULT=bedrock/bogus-model-...` — the header still
  // displayed `model us.amazon.nova-lite-v1:0` despite the actual call
  // using the bogus model. The header now reflects modelString.
  it("Tier S #2: header reflects ASSIGNEE_LLM_DEFAULT override, not the default", async () => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "bedrock/anthropic.claude-3-5-sonnet";
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi.fn().mockResolvedValue([null, "ok"] as const),
      }),
    });
    expect(section.name).toContain("anthropic.claude-3-5-sonnet");
    expect(section.name).not.toContain("nova-lite");
  });

  it("Tier S #2: header strips the bedrock/ provider prefix from the model display", async () => {
    process.env["ASSIGNEE_LLM_DEFAULT"] = "bedrock/amazon.nova-lite-v1:0";
    const section = await checkBedrock({
      llmFactory: () => ({
        generateText: vi.fn().mockResolvedValue([null, "ok"] as const),
      }),
    });
    // Should be "model amazon.nova-lite-v1:0", not "model bedrock/amazon..."
    expect(section.name).toContain("model amazon.nova-lite-v1:0");
    expect(section.name).not.toContain("model bedrock/");
  });
});

// ── MCP servers check ─────────────────────────────────────────────────────

describe("checkMcpServers", () => {
  /**
   * Construct a fake child process that exits with the given code after a
   * synchronous tick. Mirrors the shape spawn() returns.
   */
  function fakeProc(exitCode: number): {
    on: (ev: string, cb: (arg: number | Error | null) => void) => void;
    kill: () => void;
  } {
    const handlers: Record<string, (arg: number | Error | null) => void> = {};
    setImmediate(() => handlers["exit"]?.(exitCode));
    return {
      on: (ev, cb) => {
        handlers[ev] = cb;
      },
      kill: () => {},
    };
  }

  it("reports ok for every server when spawn exits cleanly", async () => {
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const spawnImpl = vi.fn().mockImplementation(() => fakeProc(0));
    const section = await checkMcpServers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      timeoutMs: 1000,
    });

    expect(section.subs).toHaveLength(5);
    expect(section.status).toBe("ok");
    for (const sub of section.subs) {
      expect(sub.status).toBe("ok");
      expect(sub.detail).toContain("launched");
    }
    expect(spawnImpl).toHaveBeenCalledTimes(5);
  });

  it("reports fail for a server whose spawn errors", async () => {
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const spawnImpl = vi.fn().mockImplementation(() => {
      const handlers: Record<string, (arg: Error | number | null) => void> = {};
      setImmediate(() => handlers["error"]?.(new Error("uvx not found")));
      return {
        on: (ev: string, cb: (arg: Error | number | null) => void) => {
          handlers[ev] = cb;
        },
        kill: () => {},
      };
    });

    const section = await checkMcpServers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      timeoutMs: 1000,
    });
    expect(section.status).toBe("fail");
    for (const sub of section.subs) {
      expect(sub.status).toBe("fail");
      expect(sub.detail).toContain("uvx not found");
    }
  });

  it("warns and skips servers whose role credentials are unavailable", async () => {
    // No reader/auditor creds configured → those servers should warn-skip,
    // not fail. Documentation server needs no creds and should still launch.
    const spawnImpl = vi.fn().mockImplementation(() => fakeProc(0));
    const section = await checkMcpServers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      timeoutMs: 1000,
    });
    expect(section.subs).toHaveLength(5);
    const docs = section.subs.find((s) =>
      s.label.includes("aws-documentation-mcp-server"),
    );
    expect(docs?.status).toBe("ok");
    const pricing = section.subs.find((s) =>
      s.label.includes("aws-pricing-mcp-server"),
    );
    expect(pricing?.status).toBe("warn");
    expect(pricing?.detail).toContain("role credentials not configured");
  });

  it("times out a server whose spawn never exits", async () => {
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const spawnImpl = vi.fn().mockImplementation(() => ({
      on: () => {},
      kill: () => {},
    }));
    const section = await checkMcpServers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnImpl: spawnImpl as any,
      timeoutMs: 25,
    });
    expect(section.status).toBe("fail");
    for (const sub of section.subs) {
      expect(sub.detail).toContain("timed out");
    }
  });
});

// Story 50-3: `checkMcpVersionDrift` and its PyPI-ping service were
// removed — version drift is now an out-of-band concern, not a doctor
// gate. The old tests for the service deleted with it.

// ── Cache check ──────────────────────────────────────────────────────────

describe("checkCache", () => {
  it("warns when ~/.assignee does not exist yet", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cache-missing-"));
    rmSync(tmp, { recursive: true, force: true });
    const section = checkCache({ homeDir: tmp });
    expect(section.status).toBe("warn");
    expect(section.subs[0]?.detail).toContain("does not exist");
  });

  it("reports ok with size, log count, and 0 stale checkpoints for a fresh dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cache-fresh-"));
    try {
      mkdirSync(join(tmp, "logs"));
      writeFileSync(join(tmp, "logs", "cli-2026-04-06.jsonl"), "{}\n");
      writeFileSync(join(tmp, "checkpoint-abc.json"), "{}");
      const section = checkCache({ homeDir: tmp });
      expect(section.status).toBe("ok");
      expect(section.subs[0]?.detail).toMatch(/0 stale checkpoints/);
      expect(section.subs[0]?.detail).toMatch(/1 log files/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("warns when a checkpoint is older than 72 hours", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cache-stale-"));
    try {
      const stale = join(tmp, "checkpoint-old.json");
      writeFileSync(stale, "{}");
      const oldTime = (Date.now() - 80 * 60 * 60 * 1000) / 1000;
      utimesSync(stale, oldTime, oldTime);
      const section = checkCache({ homeDir: tmp });
      expect(section.status).toBe("warn");
      expect(section.subs[0]?.detail).toMatch(/1 stale checkpoints/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Config check ─────────────────────────────────────────────────────────

describe("checkConfig", () => {
  it("warns when no project config file is present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cfg-none-"));
    try {
      const section = checkConfig({ cwd: tmp });
      expect(section.status).toBe("warn");
      expect(section.subs[0]?.detail).toContain("no assignee.yaml");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports ok when assignee.yaml is valid YAML", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cfg-ok-"));
    try {
      writeFileSync(
        join(tmp, "assignee.yaml"),
        "region: us-east-1\nautoFix: true\n",
      );
      const section = checkConfig({ cwd: tmp });
      expect(section.status).toBe("ok");
      expect(section.subs[0]?.label).toBe("./assignee.yaml");
      expect(section.subs[0]?.detail).toBe("valid YAML");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports fail when the YAML is malformed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-cfg-bad-"));
    try {
      writeFileSync(
        join(tmp, "assignee.yaml"),
        "region: us-east-1\n  bad indent: : :\n\t- mixed\n",
      );
      const section = checkConfig({ cwd: tmp });
      expect(section.status).toBe("fail");
      expect(section.subs[0]?.detail).toContain("failed to parse");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Best practices integrity ─────────────────────────────────────────────

describe("checkBestPractices", () => {
  it("reports ok against the real best-practices package + manifest", () => {
    const section = checkBestPractices();
    // The real manifest must verify against itself in a clean checkout —
    // any drift here is a real bug we want to catch.
    expect(section.status === "ok" || section.status === "warn").toBe(true);
    const manifestSub = section.subs.find((s) => s.label === "manifest");
    // Wave 18: strengthened — assert by label so a refactor that
    // renames the sub-check fails here instead of producing a
    // confusing `manifestSub?.detail` chain failure later.
    expect(manifestSub?.label).toBe("manifest");
    if (section.status === "ok") {
      expect(manifestSub?.detail).toContain("matches");
      // Rule count must match the project's BP coverage (>= 100 rules).
      const ruleCountMatch = manifestSub?.detail?.match(/(\d+) rules/);
      expect(ruleCountMatch).not.toBeNull();
      expect(Number(ruleCountMatch?.[1] ?? 0)).toBeGreaterThan(100);
    }
  });

  it("reports fail when the BP directory does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "doctor-bp-missing-"));
    rmSync(tmp, { recursive: true, force: true });
    const section = checkBestPractices({ bpDir: tmp });
    expect(section.status).toBe("fail");
  });

  // A8 follow-up: the BP section now surfaces resource-type and
  // compound-pattern counts as a "coverage" sub-check. Lock in the
  // label + detail shape so a future refactor that renames or moves
  // the line fails here instead of silently breaking the doctor UX.
  it("surfaces resource type + compound pattern counts in the coverage sub-check", () => {
    const section = checkBestPractices();
    const coverageSub = section.subs.find((s) => s.label === "coverage");
    expect(coverageSub?.label).toBe("coverage");
    expect(coverageSub?.status).toBe("ok");
    // Real counts are >= the current state; a future PR may add
    // types/patterns but never remove them. We assert the minimums
    // rather than the exact count so the test doesn't churn on every
    // addition.
    const resourceMatch = coverageSub?.detail?.match(/(\d+) resource types/);
    const patternMatch = coverageSub?.detail?.match(/(\d+) compound patterns/);
    expect(resourceMatch).not.toBeNull();
    expect(patternMatch).not.toBeNull();
    expect(Number(resourceMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(28);
    expect(Number(patternMatch?.[1] ?? 0)).toBeGreaterThanOrEqual(10);
  });
});

// ── Render ──────────────────────────────────────────────────────────────

describe("renderSection", () => {
  it("uses ✓ / ! / ✗ glyphs and the • bullet for sub-checks", () => {
    const out = renderSection({
      name: "Sample",
      status: "warn",
      subs: [
        { label: "alpha", status: "ok", detail: "fine" },
        { label: "beta", status: "warn" },
        { label: "gamma", status: "fail", detail: "boom" },
      ],
    });
    expect(out).toContain("[!] Sample");
    expect(out).toContain("• ✓ alpha → fine");
    expect(out).toContain("• ! beta");
    expect(out).toContain("• ✗ gamma → boom");
  });
});

// ── runDoctor end-to-end ─────────────────────────────────────────────────

describe("runDoctor", () => {
  it("returns exit code 0 with 'No issues found!' when every section is ok", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAREADEREXAMPLE001";
    process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIAAUDITOREXAMPL002";
    process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const tmp = mkdtempSync(join(tmpdir(), "doctor-e2e-ok-"));
    const cacheDir = join(tmp, "cache");
    mkdirSync(cacheDir);
    writeFileSync(join(tmp, "assignee.yaml"), "region: us-east-1\n");

    try {
      const send = vi.fn().mockResolvedValue({
        Account: "111111111111",
        Arn: "arn:aws:iam::111111111111:user/x",
      });
      const report: DoctorReport = await runDoctor({
        version: "9.9.9",
        skipBedrock: true,
        skipMcp: true,
        credentialsDeps: {
          stsClientFactory: () => ({ send }),
        },
        cacheDeps: { homeDir: cacheDir },
        configDeps: { cwd: tmp },
      });

      expect(report.version).toBe("9.9.9");
      // Story 50-3 removed the MCP version drift section → 6 sections total
      // (credentials, bedrock, mcp, cache, config, best-practices).
      expect(report.sections).toHaveLength(6);
      // Skip flags should produce 'warn' rather than 0/SUCCESS — they're
      // unverified, not "ok".
      expect(report.exitCode).toBe(2);
      expect(report.summary).toContain("warning");
      const text = renderReport(report);
      expect(text).toContain("Doctor summary (assignee.ai 9.9.9)");
      expect(text).toContain("[✓] Credentials");
      expect(text).toContain("[✓] Config");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns exit code 1 when any section is fail", async () => {
    // No credentials at all → operator fail → overall fail.
    const tmp = mkdtempSync(join(tmpdir(), "doctor-e2e-fail-"));
    try {
      const report = await runDoctor({
        version: "1.0.0",
        skipBedrock: true,
        skipMcp: true,
        credentialsDeps: {
          stsClientFactory: () => ({ send: vi.fn() }),
        },
        cacheDeps: { homeDir: tmp },
        configDeps: { cwd: tmp },
      });
      expect(report.exitCode).toBe(1);
      expect(report.summary).toContain("failure");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── doctor --short (Story 50-3) ──────────────────────────────────────────
// Replaces the removed `assignee whoami` command. Single STS call
// returning account + ARN + region + config path.

describe("runShortDoctor", () => {
  afterEach(() => {
    delete process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"];
  });

  it("prints account + ARN + region + config path when creds resolve", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    delete process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"];

    const stdoutCapture: string[] = [];
    const stderrCapture: string[] = [];
    const send = vi.fn().mockResolvedValue({
      Account: "111111111111",
      Arn: "arn:aws:iam::111111111111:user/alice",
    });

    const code = await runShortDoctor({
      stsClientFactory: () => ({ send }),
      cwd: () => "/tmp/doctor-short-nowhere",
      stdout: (m: string) => stdoutCapture.push(m),
      stderr: (m: string) => stderrCapture.push(m),
    });

    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    // When ASSIGNEE_DEMO_REDACT_ACCOUNT is unset, raw IDs appear in output.
    expect(out).toContain("Account:  111111111111");
    expect(out).toContain("User ARN: arn:aws:iam::111111111111:user/alice");
    expect(out).toMatch(/Region: /);
    expect(out).toContain("Role:     operator");
    expect(out).toContain("Redact:");
    expect(out).toContain("ASSIGNEE_DEMO_REDACT_ACCOUNT");
    expect(out).toContain("For full diagnostics");
  });

  // M-013 / CT-15: ASSIGNEE_DEMO_REDACT_ACCOUNT=1 must redact the
  // Account and User ARN lines in doctor --short output.
  it("redacts account ID and ARN when ASSIGNEE_DEMO_REDACT_ACCOUNT=1", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] = "1";

    const stdoutCapture: string[] = [];
    const send = vi.fn().mockResolvedValue({
      Account: "111111111111",
      Arn: "arn:aws:iam::111111111111:user/alice",
    });

    const code = await runShortDoctor({
      stsClientFactory: () => ({ send }),
      cwd: () => "/tmp/doctor-short-nowhere",
      stdout: (m: string) => stdoutCapture.push(m),
      stderr: () => {},
    });

    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    // Raw 12-digit account ID must NOT appear in any field.
    expect(out).not.toContain("111111111111");
    // The Account line should show the redacted placeholder.
    expect(out).toContain("Account:  ************");
    // The User ARN line should have the account segment redacted.
    expect(out).toContain("User ARN: arn:aws:iam::************:user/alice");
    // Non-sensitive fields stay unchanged.
    expect(out).toContain("Role:     operator");
    expect(out).toContain(
      "Redact:   ASSIGNEE_DEMO_REDACT_ACCOUNT=1  (demo redaction ACTIVE)",
    );
    expect(out).toContain("For full diagnostics");
  });

  it("returns a non-zero exit code + actionable stderr when no creds are set", async () => {
    const stdoutCapture: string[] = [];
    const stderrCapture: string[] = [];
    const code = await runShortDoctor({
      stdout: (m: string) => stdoutCapture.push(m),
      stderr: (m: string) => stderrCapture.push(m),
    });
    expect(code).not.toBe(0);
    expect(stderrCapture.join("")).toContain("No AWS credentials configured");
  });

  it("returns non-zero + actionable stderr when STS fails", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const stderrCapture: string[] = [];
    const send = vi
      .fn()
      .mockRejectedValue(new Error("InvalidSignatureException: bad sig"));

    const code = await runShortDoctor({
      stsClientFactory: () => ({ send }),
      stdout: () => {},
      stderr: (m: string) => stderrCapture.push(m),
    });
    expect(code).not.toBe(0);
    expect(stderrCapture.join("")).toContain(
      "Failed to verify AWS identity via STS",
    );
  });
});
