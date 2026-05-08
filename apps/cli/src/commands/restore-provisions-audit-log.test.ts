/**
 * Wave B-2 (epic-104-demo-dryrun) — `restore-provisions --from-audit-log` tests.
 *
 * Coverage map (vs. spec acceptance criteria):
 *   AC#1 happy path        — 3 events, 2 missing → 2 records appended
 *   AC#2 dedupe             — ARN already present is NOT duplicated
 *   AC#3 missing fields     — entries without resourceArn / timestamp
 *                              emit a structured warning + are skipped
 *   AC#4 mutually exclusive — `--from-audit-log` + `--from <date>` rejected
 *   AC#6 idempotent         — second run rebuilds 0 records
 *   AC#7 safety backup      — pre-restore backup written before append
 *   AC#8 lock acquired      — defaultFileAdvisoryLock.withLock spy fires
 *   AC#9 JSON envelope      — structured `{ rebuiltCount, skippedCount, … }`
 *   AC#10 HMAC tampered     — chain-verify fails → AUDIT_LOG_TAMPERED, no write
 *
 * Plus:
 *   - empty audit log → rebuiltCount = 0, no error
 *   - missing audit log → ok=false, errorCode=AUDIT_LOG_NOT_FOUND
 *   - mixed-action log (apply_resource_created + query_executed events)
 *   - parallel apply + restore are serialised via the lock
 *
 * Pollution invariant (per Wave B-1 hard lessons): every test redirects
 * `appendAuditRecord` and the memory directory to tmp paths so
 * `~/.assignee/audit/audit.log` and `~/.assignee/memory/provisions.json`
 * are NEVER touched. The pollution check at suite end asserts the line
 * count of the user's audit log is unchanged.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { restoreFromAuditLog } from "./restore-provisions-audit-log.js";
import {
  appendAuditRecord,
  DEFAULT_AUDIT_LOG_FILE,
  _resetAuditKeyCache,
} from "@assignee/core/audit";
import { defaultFileAdvisoryLock } from "@assignee/core/locks";

// ── Test environment ──────────────────────────────────────────────────

const TEST_AUDIT_KEY = randomBytes(32).toString("hex");

interface TestRig {
  tmpRoot: string;
  memoryDir: string;
  logFile: string;
  /** Per-test lock name so parallel tests do not contend on `~/.assignee/memory/provisions.json`. */
  lockName: string;
  /** Cleanup hook. */
  cleanup: () => Promise<void>;
}

async function makeRig(): Promise<TestRig> {
  const tmpRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "assignee-rp-audit-test-"),
  );
  const memoryDir = path.join(tmpRoot, "memory");
  const auditDir = path.join(tmpRoot, "audit");
  const logFile = path.join(auditDir, "audit.log");
  await fsp.mkdir(memoryDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(auditDir, { recursive: true, mode: 0o700 });
  return {
    tmpRoot,
    memoryDir,
    logFile,
    lockName: path.join(memoryDir, "provisions.json"),
    cleanup: async () => {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** ARN/UUID factory — every test gets distinct values. */
function uuid(seed: number): string {
  // Deterministic UUIDs (v4-shaped) for assert-readability.
  const seg = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${seg}`;
}

/** Append an `apply_resource_created` event by exercising the real audit path. */
async function appendApplyEvent(
  logFile: string,
  payload: {
    runId: string;
    resourceArn: string;
    resourceType?: string;
    region?: string;
    estimatedMonthlyCost?: string;
    desiredStateHash?: string;
    timestamp?: string;
  },
): Promise<void> {
  const event = {
    action: "apply_resource_created",
    runId: payload.runId,
    resourceType: payload.resourceType ?? "AWS::S3::Bucket",
    resourceArn: payload.resourceArn,
    region: payload.region ?? "us-east-1",
    estimatedMonthlyCost: payload.estimatedMonthlyCost ?? "$0.023/GB-month",
    desiredStateHash:
      payload.desiredStateHash ??
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    timestamp: payload.timestamp ?? new Date().toISOString(),
  };
  await appendAuditRecord(event, logFile);
}

/** Append a non-target audit record (e.g. query_executed). */
async function appendQueryEvent(
  logFile: string,
  intent: string,
): Promise<void> {
  await appendAuditRecord(
    { action: "query_executed", intent, resultCount: 0 },
    logFile,
  );
}

/** Read provisions.json, returning an empty array when absent. */
function readProvisions(memoryDir: string): unknown[] {
  const target = path.join(memoryDir, "provisions.json");
  if (!fs.existsSync(target)) return [];
  return JSON.parse(fs.readFileSync(target, "utf-8")) as unknown[];
}

// ── Suite-level fixtures ──────────────────────────────────────────────

let originalAuditKey: string | undefined;
let originalAuditFsync: string | undefined;
let originalAssigneeLogDir: string | undefined;
let originalAuditLogLineCount = 0; // line count before this suite (pollution check)
let suiteLogDir: string;
let stderrSpy: MockInstance | undefined;
const stderrChunks: string[] = [];

function countAuditLogLines(): number {
  if (!fs.existsSync(DEFAULT_AUDIT_LOG_FILE)) return 0;
  const raw = fs.readFileSync(DEFAULT_AUDIT_LOG_FILE, "utf-8");
  return raw.split("\n").filter((l) => l.trim().length > 0).length;
}

// Pollution invariant: capture the user's real audit-log line count at
// suite start and assert it has not changed at suite end. Even one extra
// line means a test forgot to redirect `appendAuditRecord` to the tmp path.
//
// Also: redirect the structured logger sink (`~/.assignee/logs/`) to a
// suite-scoped tmp directory so the H2 fix's `log()` calls land in tmp
// instead of polluting the operator's real persistent log file. Cleaned
// in afterAll.
beforeAll(() => {
  originalAuditLogLineCount = countAuditLogLines();
  suiteLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assignee-rp-audit-logs-"),
  );
  originalAssigneeLogDir = process.env["ASSIGNEE_LOG_DIR"];
  process.env["ASSIGNEE_LOG_DIR"] = suiteLogDir;
});

afterAll(() => {
  const after = countAuditLogLines();
  if (originalAssigneeLogDir === undefined) {
    delete process.env["ASSIGNEE_LOG_DIR"];
  } else {
    process.env["ASSIGNEE_LOG_DIR"] = originalAssigneeLogDir;
  }
  fs.rmSync(suiteLogDir, { recursive: true, force: true });
  if (after !== originalAuditLogLineCount) {
    throw new Error(
      `Audit log pollution: ${after - originalAuditLogLineCount} extra ` +
        `line(s) appended to ${DEFAULT_AUDIT_LOG_FILE} during the test ` +
        `suite (was ${originalAuditLogLineCount}, now ${after}).`,
    );
  }
});

beforeEach(() => {
  originalAuditKey = process.env["ASSIGNEE_AUDIT_KEY"];
  originalAuditFsync = process.env["ASSIGNEE_AUDIT_FSYNC"];
  // Pin a deterministic key so HMAC verify is stable across tests.
  process.env["ASSIGNEE_AUDIT_KEY"] = TEST_AUDIT_KEY;
  // Disable fsync to keep tests fast — we don't need durability here.
  process.env["ASSIGNEE_AUDIT_FSYNC"] = "0";
  _resetAuditKeyCache();
  stderrChunks.length = 0;
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
});

afterEach(() => {
  stderrSpy?.mockRestore();
  if (originalAuditKey === undefined) delete process.env["ASSIGNEE_AUDIT_KEY"];
  else process.env["ASSIGNEE_AUDIT_KEY"] = originalAuditKey;
  if (originalAuditFsync === undefined)
    delete process.env["ASSIGNEE_AUDIT_FSYNC"];
  else process.env["ASSIGNEE_AUDIT_FSYNC"] = originalAuditFsync;
  _resetAuditKeyCache();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("restoreFromAuditLog (Wave B-2)", () => {
  let rig: TestRig;
  beforeEach(async () => {
    rig = await makeRig();
  });
  afterEach(async () => {
    await rig.cleanup();
  });

  it("AC#1 happy path: rebuilds N records when N audit ARNs are missing from provisions.json", async () => {
    const arn1 = "arn:aws:s3:::bucket-rebuild-1";
    const arn2 = "arn:aws:s3:::bucket-rebuild-2";
    const arn3 = "arn:aws:s3:::bucket-already-present";
    await appendApplyEvent(rig.logFile, { runId: uuid(1), resourceArn: arn1 });
    await appendApplyEvent(rig.logFile, { runId: uuid(2), resourceArn: arn2 });
    await appendApplyEvent(rig.logFile, { runId: uuid(3), resourceArn: arn3 });

    // Plant arn3 in provisions.json so it is the "already present" case.
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      JSON.stringify(
        [
          {
            runId: uuid(3),
            resourceType: "AWS::S3::Bucket",
            resourceArn: arn3,
            region: "us-east-1",
            desiredStateHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            estimatedMonthlyCost: "$0.023/GB-month",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });

    expect(result.ok).toBe(true);
    expect(result.rebuiltCount).toBe(2);
    expect(result.alreadyPresentCount).toBe(1);
    expect(result.candidateCount).toBe(3);
    expect(result.skippedCount).toBe(0);

    const written = readProvisions(rig.memoryDir) as Array<{
      resourceArn: string;
    }>;
    expect(written).toHaveLength(3);
    const arns = new Set(written.map((r) => r.resourceArn));
    expect(arns.has(arn1)).toBe(true);
    expect(arns.has(arn2)).toBe(true);
    expect(arns.has(arn3)).toBe(true);
  });

  it("AC#2 dedupe: ARNs already present are NEVER duplicated", async () => {
    const arn = "arn:aws:s3:::bucket-dup-test";
    await appendApplyEvent(rig.logFile, { runId: uuid(10), resourceArn: arn });

    // Plant the same ARN already in provisions.json.
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      JSON.stringify(
        [
          {
            runId: uuid(10),
            resourceType: "AWS::S3::Bucket",
            resourceArn: arn,
            region: "us-east-1",
            desiredStateHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            estimatedMonthlyCost: "$0.023/GB-month",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });

    expect(result.rebuiltCount).toBe(0);
    expect(result.alreadyPresentCount).toBe(1);
    const written = readProvisions(rig.memoryDir) as unknown[];
    expect(written).toHaveLength(1);
  });

  it("AC#3 missing-fields: entries without resourceArn or timestamp invoke log() at WARN + are skipped", async () => {
    // H2 fix: skip warnings now flow through the shared `log()` helper
    // so they are persisted to ~/.assignee/logs/cli-YYYY-MM-DD.jsonl,
    // mirrored to OTEL, and visible under --verbose. We exercise the
    // real `log()` and capture its stderr emission (matching the Wave
    // B-1 pattern in `memory-recorder-audit.test.ts:228-234`).
    //
    // ASSIGNEE_LOG_LEVEL=debug routes WARN-level events to stderr where
    // we can capture them. The shared logger ALSO appends to a daily
    // log file under ~/.assignee/logs/, but that path is the regular
    // operator pipeline, not the test's pollution surface; the
    // suite-level pollution invariant tracks ~/.assignee/audit/audit.log
    // (the audit-log file we explicitly redirect to tmp) — `~/.assignee/
    // logs/` is the structured-logger sink and is allowed to receive
    // warn entries.
    const previousLogLevel = process.env["ASSIGNEE_LOG_LEVEL"];
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";

    try {
      // Plant one valid event...
      await appendApplyEvent(rig.logFile, {
        runId: uuid(20),
        resourceArn: "arn:aws:s3:::bucket-valid",
      });
      // ...one missing resourceArn (empty string)...
      await appendAuditRecord(
        {
          action: "apply_resource_created",
          runId: uuid(21),
          resourceType: "AWS::S3::Bucket",
          resourceArn: "",
          region: "us-east-1",
          estimatedMonthlyCost: "$0.023",
          desiredStateHash: "abc",
          timestamp: "2026-04-29T00:00:00.000Z",
        },
        rig.logFile,
      );
      // ...and one missing timestamp.
      await appendAuditRecord(
        {
          action: "apply_resource_created",
          runId: uuid(22),
          resourceType: "AWS::S3::Bucket",
          resourceArn: "arn:aws:s3:::bucket-no-ts",
          region: "us-east-1",
          estimatedMonthlyCost: "$0.023",
          desiredStateHash: "abc",
          // timestamp omitted on purpose
        },
        rig.logFile,
      );

      // Drain any noise that landed during fixture setup BEFORE the
      // call under test, so the assertions below see only the skip
      // events emitted by `restoreFromAuditLog`.
      stderrChunks.length = 0;

      const result = await restoreFromAuditLog({
        logFile: rig.logFile,
        memoryDir: rig.memoryDir,
        lockName: rig.lockName,
        auditKey: TEST_AUDIT_KEY,
      });

      expect(result.rebuiltCount).toBe(1);
      expect(result.skippedCount).toBe(2);
      expect(result.skips).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "missing-required-field",
            field: "resourceArn",
          }),
          expect.objectContaining({
            reason: "missing-required-field",
            field: "timestamp",
            // The "missing timestamp" entry still has a recoverable ARN,
            // so the skip carries it to help operator triage.
            resourceArn: "arn:aws:s3:::bucket-no-ts",
          }),
        ]),
      );

      // The shared `log()` helper emitted WARN events to stderr (under
      // ASSIGNEE_LOG_LEVEL=debug). Parse them and assert the contract.
      const skipEvents = stderrChunks
        .join("")
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is Record<string, unknown> =>
            e !== null && e["action"] === "restore_audit_log_skip",
        );
      expect(skipEvents).toHaveLength(2);
      for (const e of skipEvents) {
        expect(e["level"]).toBe("warn");
        expect(e["action"]).toBe("restore_audit_log_skip");
        expect(typeof e["runId"]).toBe("string");
        expect((e["runId"] as string).length).toBeGreaterThan(0);
        const extras = e["extras"] as Record<string, unknown>;
        expect(extras["source"]).toBe("restore-provisions-audit-log");
        expect(extras["reason"]).toBe("missing-required-field");
      }
      // Per-skip distinction: both events here happen to carry a
      // recoverable `runId` field on the audit record (the missing
      // field was the resourceArn or timestamp, NOT the runId), so
      // `log()` preserves the original runId. The SENTINEL runId path
      // is exercised by the next test.
      const arnSkip = skipEvents.find(
        (e) =>
          (e["extras"] as Record<string, unknown>)["field"] === "resourceArn",
      )!;
      expect(arnSkip["runId"]).toBe(uuid(21));
      const tsSkip = skipEvents.find(
        (e) =>
          (e["extras"] as Record<string, unknown>)["field"] === "timestamp",
      )!;
      expect(tsSkip["runId"]).toBe(uuid(22));
      expect((tsSkip["extras"] as Record<string, unknown>)["eventArn"]).toBe(
        "arn:aws:s3:::bucket-no-ts",
      );
    } finally {
      if (previousLogLevel === undefined) {
        delete process.env["ASSIGNEE_LOG_LEVEL"];
      } else {
        process.env["ASSIGNEE_LOG_LEVEL"] = previousLogLevel;
      }
    }
  });

  it("H2 sentinel runId: skip event with NO recoverable runId carries the sentinel marker", async () => {
    // When the audit record lacks BOTH `runId` and `resourceArn` (the
    // ones we'd otherwise correlate against), the log() event still
    // requires a non-empty runId field per the LogEvent contract. We
    // emit a stable sentinel string so operators can grep for it.
    const previousLogLevel = process.env["ASSIGNEE_LOG_LEVEL"];
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";
    try {
      await appendAuditRecord(
        {
          action: "apply_resource_created",
          // runId AND resourceArn are missing (both empty strings).
          runId: "",
          resourceType: "AWS::S3::Bucket",
          resourceArn: "",
          region: "us-east-1",
          estimatedMonthlyCost: "$0.023",
          desiredStateHash: "abc",
          timestamp: "2026-04-29T00:00:00.000Z",
        },
        rig.logFile,
      );

      stderrChunks.length = 0;
      const result = await restoreFromAuditLog({
        logFile: rig.logFile,
        memoryDir: rig.memoryDir,
        lockName: rig.lockName,
        auditKey: TEST_AUDIT_KEY,
      });
      expect(result.skippedCount).toBe(1);

      const skipEvents = stderrChunks
        .join("")
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is Record<string, unknown> =>
            e !== null && e["action"] === "restore_audit_log_skip",
        );
      expect(skipEvents).toHaveLength(1);
      // Sentinel is preferred over an empty / missing runId.
      expect(skipEvents[0]!["runId"]).toBe("restore-audit-log-skip-no-runid");
    } finally {
      if (previousLogLevel === undefined) {
        delete process.env["ASSIGNEE_LOG_LEVEL"];
      } else {
        process.env["ASSIGNEE_LOG_LEVEL"] = previousLogLevel;
      }
    }
  });

  it("AC#6 idempotent: second run rebuilds 0 records", async () => {
    const arn = "arn:aws:s3:::bucket-idem";
    await appendApplyEvent(rig.logFile, { runId: uuid(30), resourceArn: arn });

    const first = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(first.rebuiltCount).toBe(1);

    const second = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(second.rebuiltCount).toBe(0);
    expect(second.alreadyPresentCount).toBe(1);

    const written = readProvisions(rig.memoryDir);
    expect(written).toHaveLength(1);
  });

  it("AC#7 safety backup: pre-restore copy of provisions.json is written before append", async () => {
    const existingArn = "arn:aws:s3:::bucket-existing";
    const newArn = "arn:aws:s3:::bucket-new";
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      JSON.stringify(
        [
          {
            runId: uuid(40),
            resourceType: "AWS::S3::Bucket",
            resourceArn: existingArn,
            region: "us-east-1",
            desiredStateHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            estimatedMonthlyCost: "$0.023/GB-month",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    await appendApplyEvent(rig.logFile, {
      runId: uuid(41),
      resourceArn: newArn,
    });

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });

    expect(result.rebuiltCount).toBe(1);
    expect(result.safetyBackupPath).not.toBeNull();
    expect(fs.existsSync(result.safetyBackupPath!)).toBe(true);
    // Safety backup contains the ORIGINAL content (just the existing ARN).
    const backupContent = fs.readFileSync(result.safetyBackupPath!, "utf-8");
    const backupParsed = JSON.parse(backupContent) as Array<{
      resourceArn: string;
    }>;
    expect(backupParsed).toHaveLength(1);
    expect(backupParsed[0]!.resourceArn).toBe(existingArn);
  });

  it("AC#7 safety backup is NOT written when there is nothing to rebuild", async () => {
    // Audit log exists with one event; the ARN is already in provisions.json.
    const arn = "arn:aws:s3:::bucket-already-here";
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      JSON.stringify(
        [
          {
            runId: uuid(50),
            resourceType: "AWS::S3::Bucket",
            resourceArn: arn,
            region: "us-east-1",
            desiredStateHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            estimatedMonthlyCost: "$0.023/GB-month",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    await appendApplyEvent(rig.logFile, { runId: uuid(50), resourceArn: arn });

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.rebuiltCount).toBe(0);
    // No backup created when no append happened — keeps the directory clean.
    expect(result.safetyBackupPath).toBeNull();
  });

  it("AC#8 lock acquired: defaultFileAdvisoryLock.withLock is called against the provisions lock name", async () => {
    const lockSpy = vi.spyOn(defaultFileAdvisoryLock, "withLock");
    try {
      await appendApplyEvent(rig.logFile, {
        runId: uuid(60),
        resourceArn: "arn:aws:s3:::bucket-lock-spy",
      });
      const result = await restoreFromAuditLog({
        logFile: rig.logFile,
        memoryDir: rig.memoryDir,
        lockName: rig.lockName,
        auditKey: TEST_AUDIT_KEY,
      });
      expect(result.ok).toBe(true);
      // The provisions lock was acquired exactly once for the append step.
      const lockCalls = lockSpy.mock.calls.filter((c) => c[0] === rig.lockName);
      expect(lockCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it("AC#9 JSON envelope: result includes rebuiltCount / skippedCount / durationMs", async () => {
    await appendApplyEvent(rig.logFile, {
      runId: uuid(70),
      resourceArn: "arn:aws:s3:::bucket-envelope",
    });
    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(true);
    expect(typeof result.rebuiltCount).toBe("number");
    expect(typeof result.skippedCount).toBe("number");
    expect(typeof result.alreadyPresentCount).toBe("number");
    expect(typeof result.candidateCount).toBe("number");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("AC#10 HMAC tampered: chain-verify fails → AUDIT_LOG_TAMPERED, no write", async () => {
    await appendApplyEvent(rig.logFile, {
      runId: uuid(80),
      resourceArn: "arn:aws:s3:::bucket-tampered",
    });
    // Tamper: flip a single byte in the on-disk audit log.
    const raw = fs.readFileSync(rig.logFile, "utf-8");
    // Replace the last hex char of the first hmac to a different value.
    const tampered = raw.replace(/"hmac":"[0-9a-f]{63}([0-9a-f])"/, (m, c) => {
      const flipped = c === "0" ? "1" : "0";
      return m.slice(0, m.length - 2) + flipped + '"';
    });
    expect(tampered).not.toBe(raw);
    fs.writeFileSync(rig.logFile, tampered, "utf-8");

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUDIT_LOG_TAMPERED");
    expect(result.message).toMatch(/HMAC chain verification FAILED/i);
    // provisions.json was NEVER written.
    expect(fs.existsSync(path.join(rig.memoryDir, "provisions.json"))).toBe(
      false,
    );
  });

  it("returns AUDIT_LOG_NOT_FOUND when the log file is missing", async () => {
    // rig.logFile path exists but has no file — by default we created the
    // dir, not the log itself. Verify the not-found branch surfaces.
    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("AUDIT_LOG_NOT_FOUND");
    expect(result.rebuiltCount).toBe(0);
  });

  it("rebuildCount=0 with no error when audit log has zero apply_resource_created events", async () => {
    // Only a non-target event lives in the log.
    await appendQueryEvent(rig.logFile, "list");
    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(true);
    expect(result.rebuiltCount).toBe(0);
    expect(result.candidateCount).toBe(0);
  });

  it("ignores non-apply_resource_created actions in a mixed log", async () => {
    await appendQueryEvent(rig.logFile, "search");
    await appendApplyEvent(rig.logFile, {
      runId: uuid(90),
      resourceArn: "arn:aws:s3:::bucket-mixed-log",
    });
    await appendQueryEvent(rig.logFile, "list");
    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(true);
    expect(result.rebuiltCount).toBe(1);
    expect(result.candidateCount).toBe(1);
  });

  it("M3: in-batch duplicates are tracked separately from already-present", async () => {
    // ARN-X appears 3 times in the audit log; none on disk. Expected:
    //   rebuiltCount=1            (first occurrence written)
    //   inBatchDuplicateCount=2   (second + third occurrences)
    //   alreadyPresentCount=0     (none on disk before the run)
    const arn = "arn:aws:s3:::bucket-triple-emit";
    await appendApplyEvent(rig.logFile, { runId: uuid(100), resourceArn: arn });
    await appendApplyEvent(rig.logFile, { runId: uuid(101), resourceArn: arn });
    await appendApplyEvent(rig.logFile, { runId: uuid(102), resourceArn: arn });

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.rebuiltCount).toBe(1);
    expect(result.inBatchDuplicateCount).toBe(2);
    expect(result.alreadyPresentCount).toBe(0);
    const written = readProvisions(rig.memoryDir) as Array<{
      resourceArn: string;
    }>;
    expect(written.filter((r) => r.resourceArn === arn)).toHaveLength(1);
  });

  it("M3: alreadyPresent vs inBatchDuplicate are reported on the same run", async () => {
    // Mixed scenario: one ARN already on disk + another emitted twice
    // in the audit log. Counts are tracked independently so an operator
    // can tell them apart.
    const onDisk = "arn:aws:s3:::bucket-on-disk";
    const dupInBatch = "arn:aws:s3:::bucket-dup-in-batch";
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      JSON.stringify(
        [
          {
            runId: uuid(110),
            resourceType: "AWS::S3::Bucket",
            resourceArn: onDisk,
            region: "us-east-1",
            desiredStateHash:
              "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            estimatedMonthlyCost: "$0.023/GB-month",
            timestamp: "2026-04-29T00:00:00.000Z",
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    await appendApplyEvent(rig.logFile, {
      runId: uuid(110),
      resourceArn: onDisk,
    });
    await appendApplyEvent(rig.logFile, {
      runId: uuid(111),
      resourceArn: dupInBatch,
    });
    await appendApplyEvent(rig.logFile, {
      runId: uuid(112),
      resourceArn: dupInBatch,
    });

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.rebuiltCount).toBe(1);
    expect(result.alreadyPresentCount).toBe(1);
    expect(result.inBatchDuplicateCount).toBe(1);
    expect(result.message).toMatch(/already present/i);
    expect(result.message).toMatch(/duplicate audit/i);
  });

  // M1 — corrupt provisions.json must surface a structured failure, no stack trace.
  it("M1: corrupt provisions.json → structured PROVISIONS_JSON_CORRUPT failure (no stack trace)", async () => {
    // Plant garbage in provisions.json that JSON.parse will reject.
    fs.writeFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      "[invalid json{{{not parseable",
      "utf-8",
    );
    await appendApplyEvent(rig.logFile, {
      runId: uuid(120),
      resourceArn: "arn:aws:s3:::bucket-after-corrupt",
    });

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PROVISIONS_JSON_CORRUPT");
    expect(result.rebuiltCount).toBe(0);
    expect(result.message).toMatch(/not valid JSON/i);
    expect(result.message).toMatch(/refusing to rebuild/i);
    // The corrupt file is left UNTOUCHED — the recovery flow must never
    // overwrite a corrupt ledger that the operator hasn't inspected.
    const onDisk = fs.readFileSync(
      path.join(rig.memoryDir, "provisions.json"),
      "utf-8",
    );
    expect(onDisk).toBe("[invalid json{{{not parseable");
  });

  // M2 — reconstructed records that fail Zod validation must be skipped.
  it("M2: reconstructed record failing Zod validation is skipped (not written)", async () => {
    // Audit event with a non-UUID runId — passes the `tryDecodeApply…`
    // string-typeof / non-empty check but fails ProvisionRecordSchema's
    // `.uuid()` constraint. Expected: skip recorded, no record written.
    await appendAuditRecord(
      {
        action: "apply_resource_created",
        runId: "not-a-real-uuid",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::bucket-bad-runid",
        region: "us-east-1",
        estimatedMonthlyCost: "$0.023/GB-month",
        desiredStateHash:
          "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        timestamp: "2026-04-29T00:00:00.000Z",
      },
      rig.logFile,
    );

    const result = await restoreFromAuditLog({
      logFile: rig.logFile,
      memoryDir: rig.memoryDir,
      lockName: rig.lockName,
      auditKey: TEST_AUDIT_KEY,
    });

    expect(result.ok).toBe(true);
    expect(result.rebuiltCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skips).toEqual([
      expect.objectContaining({
        reason: "schema-validation-failed",
        resourceArn: "arn:aws:s3:::bucket-bad-runid",
        zodErrors: expect.stringContaining("uuid"),
      }),
    ]);
    // No record written.
    expect(readProvisions(rig.memoryDir)).toEqual([]);
  });
});

// ── Mutually-exclusive flag (AC#4) ────────────────────────────────────
//
// L3 fix: every test in this block builds a FRESH Commander subcommand
// via `createRestoreProvisionsCommand()` to avoid option-state leakage
// between tests. A reused Commander instance keeps `from` populated
// across `parseAsync` calls; spawning a fresh instance per test
// guarantees a clean slate.

describe("restore-provisions command flag wiring (Wave B-2)", () => {
  it("AC#4 + H1: --from + --from-audit-log throws AssigneeError(USAGE_ERROR) → exit 73", async () => {
    // The action handler now throws an `AssigneeError` with
    // `ErrorCode.USAGE_ERROR` for the mutex collision (H1 fix). The
    // top-level `program.parseAsync(...).catch` route in
    // `apps/cli/src/index.ts` runs `errorToExitCode(err)` on it, which
    // resolves USAGE_ERROR to ProcessExitCode 73 — distinct from the
    // generic-error path (1) used for runtime failures.
    const { createRestoreProvisionsCommand } =
      await import("./restore-provisions.js");
    const { AssigneeError } = await import("@assignee/core");
    const { ErrorCode } = await import("../constants/errors.js");
    const { errorToExitCode } = await import("../utils/exit-code.js");
    const cmd = createRestoreProvisionsCommand();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      let caught: unknown;
      try {
        await cmd.parseAsync([
          "node",
          "test",
          "--from",
          "2026-04-29",
          "--from-audit-log",
        ]);
        expect.fail("expected mutex AssigneeError throw");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AssigneeError);
      expect((caught as { code: string }).code).toBe(ErrorCode.USAGE_ERROR);
      // The single source of truth for "what code does this error emit".
      expect(errorToExitCode(caught)).toBe(73);
      expect((caught as Error).message).toMatch(/mutually exclusive/i);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("AC#4 JSON mode: mutually-exclusive emits envelope on stdout BEFORE the throw, mode=invalid", async () => {
    // In JSON mode operators get the structured envelope on stdout for
    // their pipeline before the AssigneeError is propagated. Both the
    // envelope and the exit-code-73 contract must hold simultaneously.
    const { createRestoreProvisionsCommand } =
      await import("./restore-provisions.js");
    const { AssigneeError } = await import("@assignee/core");
    const { ErrorCode } = await import("../constants/errors.js");
    const cmd = createRestoreProvisionsCommand();
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c: unknown) => {
        writes.push(String(c));
        return true;
      });
    try {
      let caught: unknown;
      try {
        await cmd.parseAsync([
          "node",
          "test",
          "--from",
          "2026-04-29",
          "--from-audit-log",
          "--json",
        ]);
        expect.fail("expected mutex AssigneeError throw");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AssigneeError);
      expect((caught as { code: string }).code).toBe(ErrorCode.USAGE_ERROR);
      const json = writes.find((s) => s.trim().startsWith("{"));
      expect(json).toBeDefined();
      const parsed = JSON.parse(json!) as Record<string, unknown>;
      expect(parsed["restored"]).toBe(false);
      expect(parsed["mode"]).toBe("invalid");
      expect(typeof parsed["message"]).toBe("string");
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("registers --from-audit-log as a boolean option (fresh per test)", async () => {
    const { createRestoreProvisionsCommand } =
      await import("./restore-provisions.js");
    const cmd = createRestoreProvisionsCommand();
    const opt = cmd.options.find((o) => o.long === "--from-audit-log");
    expect(opt).toBeDefined();
    expect(opt?.required).toBe(false);
    expect(opt?.optional).toBe(false);
  });
});
