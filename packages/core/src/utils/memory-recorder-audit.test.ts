/**
 * Wave B-1 (epic-104-demo-dryrun) — apply_resource_created audit event tests.
 *
 * Verifies that `writeProvisionRecord` emits a per-resource audit event
 * after a successful `appendProvision` so the future
 * `restore-provisions --from-audit-log` flag (Wave B-2) can rebuild a
 * missing record from the HMAC-chained log alone.
 *
 * Coverage (real-data, all-cases per .claude/rules/testing.md):
 *   1. Happy path — one new entry with all six required fields.
 *   2. Audit-emit failure does NOT break the provision write (a structured
 *      stderr warning is emitted instead).
 *   3. desiredState=undefined still emits the event with the SHA-256 of
 *      `{}` (matching the in-record hash); no `undefined` lands in JSON.
 *   4. HMAC chain integrity — the new entry joins the chain and
 *      `verifyAuditLog` returns ok=true.
 *   5. Failed appendProvision suppresses the audit event (audit events
 *      are evidence of successful operations).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { writeProvisionRecord } from "./memory-recorder.js";
import { MemoryService } from "../services/memory/service.js";
import * as memoryModule from "../services/memory.js";
import * as auditLogModule from "../audit/audit-log.js";
import { LOG_ACTIONS } from "./logger/index.js";
import { verifyAuditLog } from "../audit/audit-verifier.js";
import type { ConfigPort } from "../config/config-port.js";

// ── Test environment ─────────────────────────────────────────────────────────
//
// The HMAC chain requires a stable audit key. We pin one for the suite so
// every test sees the same key and chain verification is deterministic.
// 32 random bytes hex-encoded easily clears the AUDIT_KEY_MIN_LENGTH gate.
const TEST_AUDIT_KEY = randomBytes(32).toString("hex");

// ── Helpers ──────────────────────────────────────────────────────────────────

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `assignee-audit-b1-test-${randomBytes(6).toString("hex")}.log`,
  );
}

async function makeTmpMemoryService(): Promise<{
  service: MemoryService;
  dir: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-mem-b1-test-"));
  const service = new MemoryService(dir);
  return { service, dir };
}

async function readEntries(logFile: string): Promise<unknown[]> {
  let content: string;
  try {
    content = await fs.readFile(logFile, "utf-8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

// ── Suite-level fixtures ─────────────────────────────────────────────────────

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const S3_ARN = "arn:aws:s3:::assignee-b1-test-bucket-2026";
const REGION = "us-east-1";
const COST = "$0.023/GB-month";

let tmpDir: string;
let tmpMem: MemoryService;
let tmpLogFile: string;

let appendProvisionSpy:
  | MockInstance<MemoryService["appendProvision"]>
  | undefined;
let auditSpy: MockInstance<typeof auditLogModule.appendAuditRecord> | undefined;

let originalEnvKey: string | undefined;
let originalEnvRegion: string | undefined;

beforeEach(async () => {
  // Tmp memory dir + service (intercepts the singleton's appendProvision).
  const tmp = await makeTmpMemoryService();
  tmpDir = tmp.dir;
  tmpMem = tmp.service;

  // Tmp audit log path.
  tmpLogFile = tempLogFile();

  // Pin the audit key + region so HMAC verification is deterministic and
  // writeProvisionRecord does not fall back to UNKNOWN_FALLBACK for region.
  originalEnvKey = process.env["ASSIGNEE_AUDIT_KEY"];
  originalEnvRegion = process.env["AWS_REGION"];
  process.env["ASSIGNEE_AUDIT_KEY"] = TEST_AUDIT_KEY;
  process.env["AWS_REGION"] = REGION;

  // Redirect defaultMemoryService.appendProvision to the tmp service so the
  // production code path is exercised end-to-end without writing to
  // ~/.assignee/memory/.
  appendProvisionSpy = vi
    .spyOn(memoryModule.defaultMemoryService, "appendProvision")
    .mockImplementation((record) => tmpMem.appendProvision(record));

  // Redirect appendAuditRecord to the tmp audit log file so the HMAC chain
  // is built in isolation. The real implementation runs (chain integrity is
  // exercised end-to-end); only the file path is rewritten.
  const realAppend = auditLogModule.appendAuditRecord;
  auditSpy = vi
    .spyOn(auditLogModule, "appendAuditRecord")
    .mockImplementation((record, _logFile, config) =>
      realAppend(record, tmpLogFile, config),
    );
});

afterEach(async () => {
  appendProvisionSpy?.mockRestore();
  auditSpy?.mockRestore();
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.unlink(tmpLogFile).catch(() => {});
  if (originalEnvKey === undefined) {
    delete process.env["ASSIGNEE_AUDIT_KEY"];
  } else {
    process.env["ASSIGNEE_AUDIT_KEY"] = originalEnvKey;
  }
  if (originalEnvRegion === undefined) {
    delete process.env["AWS_REGION"];
  } else {
    process.env["AWS_REGION"] = originalEnvRegion;
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("writeProvisionRecord — emits apply_resource_created audit event (Wave B-1)", () => {
  it("AC#1: happy path — one entry with all six required fields populated", async () => {
    const desiredState = { BucketName: "assignee-b1-test-bucket-2026" };

    await writeProvisionRecord(
      RUN_ID,
      "AWS::S3::Bucket",
      S3_ARN,
      desiredState,
      COST,
    );

    expect(auditSpy).toHaveBeenCalledTimes(1);

    const entries = await readEntries(tmpLogFile);
    expect(entries).toHaveLength(1);

    // Audit envelope validates: index, hmac, prevHmac=GENESIS, role, ts.
    const envelope = entries[0] as {
      index: number;
      hmac: string;
      prevHmac: string;
      role: string;
      timestamp: string;
      record: unknown;
    };
    expect(envelope.index).toBe(0);
    expect(envelope.prevHmac).toBe("GENESIS");
    expect(envelope.hmac).toMatch(/^[0-9a-f]{64}$/);

    // The inner record carries the apply_resource_created shape with all
    // six required fields populated.
    const rec = envelope.record as {
      action: string;
      runId: string;
      resourceType: string;
      resourceArn: string;
      region: string;
      estimatedMonthlyCost: string;
      desiredStateHash: string;
      timestamp: string;
    };
    expect(rec.action).toBe("apply_resource_created");
    expect(rec.runId).toBe(RUN_ID);
    expect(rec.resourceType).toBe("AWS::S3::Bucket");
    expect(rec.resourceArn).toBe(S3_ARN);
    expect(rec.region).toBe(REGION);
    expect(rec.estimatedMonthlyCost).toBe(COST);
    expect(rec.desiredStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof rec.timestamp).toBe("string");
    expect(() => new Date(rec.timestamp).toISOString()).not.toThrow();

    // The audit event's hash MUST equal the hash on the persisted
    // ProvisionRecord — Wave B-2 reconstruction depends on this equality.
    const persisted = await tmpMem.readProvisions();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.desiredStateHash).toBe(rec.desiredStateHash);
    expect(persisted[0]!.timestamp).toBe(rec.timestamp);
    expect(persisted[0]!.region).toBe(rec.region);
  });

  it("AC#2: audit-emit failure does NOT break the provision write", async () => {
    // Force appendAuditRecord to throw — the provision write must still
    // succeed and a structured warning must be emitted via the logger
    // (which routes to stderr in verbose / debug mode).
    auditSpy!.mockImplementationOnce(async () => {
      throw new Error("simulated audit log I/O failure");
    });

    // Enable verbose mode so warn-level events route to stderr where we
    // can capture them. The CLI sets ASSIGNEE_LOG_LEVEL=debug as the
    // canonical way to opt in.
    const previousLogLevel = process.env["ASSIGNEE_LOG_LEVEL"];
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";

    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk));
        return true;
      });

    try {
      await expect(
        writeProvisionRecord(
          RUN_ID,
          "AWS::S3::Bucket",
          S3_ARN,
          { BucketName: "boom" },
          COST,
        ),
      ).resolves.not.toThrow();
    } finally {
      stderrSpy.mockRestore();
      if (previousLogLevel === undefined) {
        delete process.env["ASSIGNEE_LOG_LEVEL"];
      } else {
        process.env["ASSIGNEE_LOG_LEVEL"] = previousLogLevel;
      }
    }

    // Provision record is the source of truth — it landed.
    const persisted = await tmpMem.readProvisions();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.resourceArn).toBe(S3_ARN);

    // No audit log file was created (the only emit attempt threw).
    const entries = await readEntries(tmpLogFile);
    expect(entries).toHaveLength(0);

    // The structured warning landed on stderr with the contract-required
    // fields: warn level, MEMORY_WRITE_FAILED action, the audit-emit
    // error text, and the event discriminator.
    const stderrLines = stderrChunks
      .join("")
      .split("\n")
      .filter((l) => l.startsWith("{"));
    const warnLine = stderrLines.find(
      (l) =>
        l.includes(LOG_ACTIONS.MEMORY_WRITE_FAILED) &&
        l.includes("apply_resource_created"),
    );
    expect(warnLine, "expected a warn-level log line on stderr").toBeDefined();
    const parsed = JSON.parse(warnLine!) as {
      level: string;
      action: string;
      runId: string;
      extras?: Record<string, unknown>;
    };
    expect(parsed.level).toBe("warn");
    expect(parsed.action).toBe(LOG_ACTIONS.MEMORY_WRITE_FAILED);
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.extras?.["event"]).toBe("apply_resource_created");
    expect(parsed.extras?.["auditEmitError"]).toBe(
      "simulated audit log I/O failure",
    );
  });

  it("AC#3: desiredState=undefined emits event with SHA-256 of '{}', no undefined in JSON", async () => {
    await writeProvisionRecord(
      RUN_ID,
      "AWS::S3::Bucket",
      S3_ARN,
      undefined,
      COST,
    );

    const entries = await readEntries(tmpLogFile);
    expect(entries).toHaveLength(1);

    const envelope = entries[0] as { record: { desiredStateHash: string } };
    // SHA-256 of `{}` is a known constant — same hash that
    // writeProvisionRecord persists when desiredState is omitted.
    const SHA256_OF_EMPTY_OBJECT =
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    expect(envelope.record.desiredStateHash).toBe(SHA256_OF_EMPTY_OBJECT);

    const persisted = await tmpMem.readProvisions();
    expect(persisted[0]!.desiredStateHash).toBe(SHA256_OF_EMPTY_OBJECT);

    // The on-disk audit JSON line must not contain the literal string
    // "undefined" — that would be a serialisation bug.
    const raw = await fs.readFile(tmpLogFile, "utf-8");
    expect(raw).not.toContain("undefined");
  });

  it("AC#4: HMAC chain integrity — verifyAuditLog returns ok=true after multiple emits", async () => {
    // Three sequential apply events. The chain must verify end-to-end.
    await writeProvisionRecord(
      "550e8400-e29b-41d4-a716-446655440001",
      "AWS::S3::Bucket",
      "arn:aws:s3:::chain-test-bucket-1",
      { BucketName: "chain-test-bucket-1" },
      COST,
    );
    await writeProvisionRecord(
      "550e8400-e29b-41d4-a716-446655440002",
      "AWS::Lambda::Function",
      "arn:aws:lambda:us-east-1:112233445566:function:chain-test-fn",
      { FunctionName: "chain-test-fn" },
      "$0.20/mo",
    );
    await writeProvisionRecord(
      "550e8400-e29b-41d4-a716-446655440003",
      "AWS::S3::Bucket",
      "arn:aws:s3:::chain-test-bucket-3",
      { BucketName: "chain-test-bucket-3" },
      COST,
    );

    const entries = await readEntries(tmpLogFile);
    expect(entries).toHaveLength(3);

    const result = await verifyAuditLog(tmpLogFile, TEST_AUDIT_KEY);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);

    // Indices monotonically increase 0 → 1 → 2.
    const e0 = entries[0] as { index: number; prevHmac: string; hmac: string };
    const e1 = entries[1] as { index: number; prevHmac: string; hmac: string };
    const e2 = entries[2] as { index: number; prevHmac: string; hmac: string };
    expect(e0.index).toBe(0);
    expect(e1.index).toBe(1);
    expect(e2.index).toBe(2);
    expect(e1.prevHmac).toBe(e0.hmac);
    expect(e2.prevHmac).toBe(e1.hmac);
  });

  it("AC#5: failed appendProvision suppresses the audit event", async () => {
    appendProvisionSpy!.mockImplementationOnce(async () => {
      throw new Error("simulated provision write failure");
    });

    await expect(
      writeProvisionRecord(
        RUN_ID,
        "AWS::S3::Bucket",
        S3_ARN,
        { BucketName: "no-audit" },
        COST,
      ),
    ).resolves.not.toThrow();

    // appendAuditRecord must NOT have been called — audit events are
    // evidence of successful operations only.
    expect(auditSpy).not.toHaveBeenCalled();

    // No audit log file produced.
    const entries = await readEntries(tmpLogFile);
    expect(entries).toHaveLength(0);
  });

  it("supports the optional ConfigPort parameter for SaaS multi-tenant key resolution", async () => {
    // MASTER-009 invariant: when a ConfigPort is supplied to
    // writeProvisionRecord it MUST be forwarded to appendAuditRecord so
    // tenant-scoped keys are honoured. We check the spy was called with
    // a third argument that is the same instance the caller passed.
    const tenantConfig: ConfigPort = {
      get(name: string): string | undefined {
        if (name === "AWS_REGION") return REGION;
        if (name === "ASSIGNEE_AUDIT_KEY") return TEST_AUDIT_KEY;
        return undefined;
      },
      getRequired(name: string): string {
        const v = this.get(name);
        if (v === undefined) throw new Error(`Missing config: ${name}`);
        return v;
      },
      getInt(): number | undefined {
        return undefined;
      },
      getBool(): boolean | undefined {
        return undefined;
      },
    };

    await writeProvisionRecord(
      RUN_ID,
      "AWS::S3::Bucket",
      S3_ARN,
      { BucketName: "tenant-config-test" },
      COST,
      tenantConfig,
    );

    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [, , forwardedConfig] = auditSpy!.mock.calls[0]!;
    expect(forwardedConfig).toBe(tenantConfig);
  });
});
