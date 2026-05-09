import { describe, it, expect, vi, beforeEach } from "vitest";
import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";

const { mockResolveDefaultKms, mockAppendAuditRecord } = vi.hoisted(() => ({
  mockResolveDefaultKms: vi.fn(),
  mockAppendAuditRecord: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/apply-time-kms-resolver.js", () => ({
  resolveDefaultKmsKeyForApply: mockResolveDefaultKms,
}));

// Pollution discipline (Wave B-1 hard lesson, mirrors D-1) — even though the
// primary mock prevents the helper reaching audit-log code, mock the audit-log
// module belt-and-braces in case any indirect path emits.
vi.mock("../../../audit/audit-log.js", () => ({
  appendAuditRecord: mockAppendAuditRecord,
}));

import { ensureSqsDefaultKms } from "./sqs-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

/**
 * Test-only override shape: widens AgentState's `runId: string` to
 * `string | undefined` so AC-D2-6 (runId absent) can be expressed
 * without a double-cast that hides the type-narrowing intent. The
 * helper itself dereferences `state.runId` via the `state.runId ?
 * { runId: state.runId } : {}` spread so an undefined value is the
 * supported absent case.
 */
type StateOverrides = Partial<Omit<AgentState, "runId">> & {
  runId?: string | undefined;
};

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d2-001",
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureSqsDefaultKms", () => {
  beforeEach(() => {
    mockResolveDefaultKms.mockReset();
    mockAppendAuditRecord.mockReset();
    mockResolveDefaultKms.mockResolvedValue({
      keyArn: RESOLVED_KEY_ARN,
      aliasName: RESOLVED_ALIAS,
      created: false,
      accountId: "112233445566",
    });
  });

  it("AC-D2-1: substitutes resolved alias-name into SQS queue lacking KmsMasterKeyId", async () => {
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      VisibilityTimeout: 30,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    // I-D2-2: alias-name form, NEVER the key-ARN form.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D2-2 (user wins, ARN form): user-supplied key ARN preserved verbatim — resolver NOT invoked", async () => {
    const userArn =
      "arn:aws:kms:us-east-1:999999999999:key/user-supplied-cmk-uuid";
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.KMS_MASTER_KEY_ID]: userArn,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(userArn);
  });

  it("AC-D2-2 (user wins, alias form): user-supplied alias/aws/sqs preserved verbatim — resolver NOT invoked", async () => {
    const userAlias = "alias/aws/sqs";
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.KMS_MASTER_KEY_ID]: userAlias,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(userAlias);
  });

  it("AC-D2-2 (whitespace edge): empty / whitespace KmsMasterKeyId treated as missing", async () => {
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.KMS_MASTER_KEY_ID]: "   ",
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D2-7 (I-D2-6 SSE-SQS skip): SqsManagedSseEnabled === true → no-op, resolver NOT invoked, KmsMasterKeyId stays absent", async () => {
    // Mirrors the SQS plugin's default path (sqs-queue.ts:217 sets
    // SqsManagedSseEnabled: true). AWS rejects an apply with both
    // SqsManagedSseEnabled AND KmsMasterKeyId set — the helper must
    // skip the resolver and leave KmsMasterKeyId absent so CCAPI gets
    // a valid SSE-SQS-only desiredState.
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.SQS_MANAGED_SSE]: true,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBeUndefined();
    // SqsManagedSseEnabled itself is untouched.
    expect(desired[CfnKey.SQS_MANAGED_SSE]).toBe(true);
  });

  it("AC-D2-7 (SSE-SQS truthy-but-not-true): SqsManagedSseEnabled = 'true' (string) → NOT treated as opt-in, resolver still invoked", async () => {
    // Strict equality === true means only the boolean true short-circuits.
    // A string "true" or numeric 1 is NOT the AWS-emitted shape and we
    // proceed with default-CMK injection (the desired-state-sanitizer
    // would normalise upstream; here we just document the contract).
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.SQS_MANAGED_SSE]: "true",
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D2-7 (SSE-SQS explicitly false): SqsManagedSseEnabled === false → proceeds with default-CMK injection", async () => {
    // Operator opted out of SSE-SQS — they want SOME encryption but
    // didn't supply a key. The hook fires and substitutes the default.
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.SQS_MANAGED_SSE]: false,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D2-7 (precedence): user-supplied KmsMasterKeyId wins even when SqsManagedSseEnabled === true", async () => {
    // Defensive contract: if BOTH end up set on the desiredState
    // (operator authored both, or upstream sanitiser bug), the user's
    // explicit KmsMasterKeyId is preserved verbatim — we still skip
    // the resolver. The conflict between the two fields is an
    // upstream sanitiser concern, NOT this hook's to repair.
    const userArn =
      "arn:aws:kms:us-east-1:999999999999:key/user-supplied-cmk-uuid";
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.SQS_MANAGED_SSE]: true,
      [CfnKey.KMS_MASTER_KEY_ID]: userArn,
    };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(userArn);
  });

  it("AC-D2-3: non-SQS resource (S3 bucket) — no-op, zero calls", async () => {
    const desired: Record<string, unknown> = {
      BucketName: "test-bucket",
      // Field present but should be ignored — wrong resource type.
      [CfnKey.KMS_MASTER_KEY_ID]: "",
    };
    const r = await ensureSqsDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    // desiredState untouched.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe("");
  });

  it("AC-D2-4 (Error): resolver throws an Error → fail-closed with structured errorMessage mentioning alias/aws/sqs", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain(
        "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error",
      );
      // I-D2-3: actionable hint surfaces the AWS-managed escape hatch.
      expect(r.errorMessage).toContain("alias/aws/sqs");
      expect(r.errorMessage).toContain("KmsMasterKeyId");
    }
    // CCAPI substitution must NOT have happened.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBeUndefined();
  });

  it("AC-D2-4 (non-Error): resolver throws non-Error → falls back to String(err) in message", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce("plain string failure");
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    const r = await ensureSqsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("plain string failure");
      // Escape-hatch hint is unconditional.
      expect(r.errorMessage).toContain("alias/aws/sqs");
    }
  });

  it("AC-D2-5: two SQS queues in one apply (helper invoked twice) — both substituted; resolver invoked once per queue (cache reuse verified upstream)", async () => {
    const desired1: Record<string, unknown> = { QueueName: "queue-1" };
    const desired2: Record<string, unknown> = { QueueName: "queue-2" };

    const r1 = await ensureSqsDefaultKms(baseState(), desired1);
    const r2 = await ensureSqsDefaultKms(baseState(), desired2);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Helper invoked once per queue. The upstream alias-resolver caches
    // by (accountId, region) — verified in D-0 tests. Here we assert
    // the helper itself doesn't double-call within a single invocation
    // and that both queues end up with the resolved alias-name.
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
    expect(desired1[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired2[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D2-6 (runId set): forwards runId to the resolver opts", async () => {
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    await ensureSqsDefaultKms(
      baseState({ runId: "run-d2-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d2-runid-test" }),
    );
  });

  it("AC-D2-6 (runId absent): does NOT forward an undefined runId key", async () => {
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    await ensureSqsDefaultKms(baseState({ runId: undefined }), desired);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D2-2 (form choice): substituted value equals aliasName, NEVER keyArn", async () => {
    // Belt-and-braces: a dedicated assertion for the load-bearing
    // difference vs Wave D-1 (S3 threads keyArn; SQS threads aliasName).
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    await ensureSqsDefaultKms(baseState(), desired);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("I-D2-4 (pollution discipline): no audit records emitted by this module directly", async () => {
    const desired: Record<string, unknown> = { QueueName: "test-queue" };
    await ensureSqsDefaultKms(baseState(), desired);
    // Underlying resolver is mocked → real audit-log code never reached.
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
