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

// Pollution discipline (Wave B-1 hard lesson, mirrors D-1/D-2) — even though
// the primary mock prevents the helper reaching audit-log code, mock the
// audit-log module belt-and-braces in case any indirect path emits.
vi.mock("../../../audit/audit-log.js", () => ({
  appendAuditRecord: mockAppendAuditRecord,
}));

import { ensureSnsDefaultKms } from "./sns-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

/** The AWS-managed SNS key alias literal — the discriminator sentinel. */
const SNS_AWS_MANAGED_LITERAL = "alias/aws/sns";

/**
 * Test-only override shape: widens AgentState's `runId: string` to
 * `string | undefined` so AC-D3-7 (runId absent) can be expressed
 * without a double-cast that hides the type-narrowing intent. The
 * helper itself dereferences `state.runId` via the `state.runId ?
 * { runId: state.runId } : {}` spread so an undefined value is the
 * supported absent case. (Mirrors D-2's StateOverrides.)
 */
type StateOverrides = Partial<Omit<AgentState, "runId">> & {
  runId?: string | undefined;
};

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d3-001",
    resourceType: RESOURCE_TYPES.SNS_TOPIC,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureSnsDefaultKms", () => {
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

  it("AC-D3-1: substitutes resolved alias-name into SNS topic lacking KmsMasterKeyId", async () => {
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
      DisplayName: "Test Topic",
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    // I-D3-2: alias-name form, NEVER the key-ARN form.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D3-2 (load-bearing — sentinel UPGRADE): KmsMasterKeyId === 'alias/aws/sns' → resolver invoked, sentinel REPLACED", async () => {
    // The SNS plugin's defaults block ships this literal for every
    // bare-intent topic (sns-topic.ts:162). At apply-time the helper
    // recognises it as the "no operator preference" sentinel and
    // upgrades to the Assignee default CMK. This is the load-bearing
    // Option A behaviour vs D-2's SQS skip pattern.
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
      [CfnKey.KMS_MASTER_KEY_ID]: SNS_AWS_MANAGED_LITERAL,
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    // The sentinel literal must NOT survive — that's the entire point.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).not.toBe(SNS_AWS_MANAGED_LITERAL);
  });

  it("AC-D3-3 (user wins, ARN form): user-supplied key ARN preserved verbatim — resolver NOT invoked", async () => {
    const userArn =
      "arn:aws:kms:us-east-1:999999999999:key/user-supplied-cmk-uuid";
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-cafef00d",
      [CfnKey.KMS_MASTER_KEY_ID]: userArn,
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(userArn);
  });

  it("AC-D3-3 (user wins, custom alias-name): user-supplied 'alias/my-team-cmk' preserved — resolver NOT invoked", async () => {
    // Any non-sentinel non-empty string is operator intent. A custom
    // alias-name (not equal to the sentinel literal) is preserved.
    const userAlias = "alias/my-team-cmk";
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-cafef00d",
      [CfnKey.KMS_MASTER_KEY_ID]: userAlias,
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(userAlias);
  });

  it("AC-D3-3 (user wins, escape-hatch alias-ARN): 'arn:aws:kms:us-east-1:112233445566:alias/aws/sns' preserved — resolver NOT invoked", async () => {
    // The documented escape hatch: an operator who genuinely wants
    // the AWS-managed SSE-SNS key supplies the alias-ARN form. This
    // is NOT equal to the bare literal sentinel `alias/aws/sns`, so
    // the discriminator preserves it. AWS CCAPI accepts the
    // alias-ARN form as a valid KmsMasterKeyId.
    const escapeHatch = "arn:aws:kms:us-east-1:112233445566:alias/aws/sns";
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-cafef00d",
      [CfnKey.KMS_MASTER_KEY_ID]: escapeHatch,
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(escapeHatch);
  });

  it("AC-D3-3 (whitespace edge): empty / whitespace KmsMasterKeyId treated as missing", async () => {
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
      [CfnKey.KMS_MASTER_KEY_ID]: "   ",
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D3-3 (whitespace-padded sentinel): '  alias/aws/sns  ' treated as the sentinel after trim → substituted", async () => {
    // Documents the "what is a sentinel" contract: trim then compare.
    // Sanitiser leftover whitespace must not bypass the upgrade.
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
      [CfnKey.KMS_MASTER_KEY_ID]: `  ${SNS_AWS_MANAGED_LITERAL}  `,
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D3-4: non-SNS resource (SQS queue) — no-op, zero calls", async () => {
    // Use a sentinel value to prove the resource-type guard short-
    // circuits BEFORE the discriminator runs.
    const desired: Record<string, unknown> = {
      QueueName: "test-queue",
      [CfnKey.KMS_MASTER_KEY_ID]: SNS_AWS_MANAGED_LITERAL,
    };
    const r = await ensureSnsDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    // desiredState untouched — sentinel literal preserved because the
    // wrong-resource-type guard skipped the helper entirely.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(SNS_AWS_MANAGED_LITERAL);
  });

  it("AC-D3-5 (Error): resolver throws an Error → fail-closed with structured errorMessage mentioning alias/aws/sns + escape hatch", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain(
        "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error",
      );
      // I-D3-3: actionable hint surfaces the AWS-managed sentinel...
      expect(r.errorMessage).toContain("alias/aws/sns");
      // ...AND the alias-ARN escape hatch (the literal substring is
      // present in the helper's error template).
      expect(r.errorMessage).toContain(
        "arn:aws:kms:<region>:<account>:alias/aws/sns",
      );
      expect(r.errorMessage).toContain("KmsMasterKeyId");
    }
    // CCAPI substitution must NOT have happened — no resolved alias
    // was written to desiredState.
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBeUndefined();
  });

  it("AC-D3-5 (non-Error): resolver throws non-Error → falls back to String(err) in message", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce("plain string failure");
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    const r = await ensureSnsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("plain string failure");
      // Escape-hatch hint is unconditional.
      expect(r.errorMessage).toContain("alias/aws/sns");
    }
  });

  it("AC-D3-6: two SNS topics in one apply (helper invoked twice) — both substituted; resolver invoked once per topic (cache reuse verified upstream)", async () => {
    const desired1: Record<string, unknown> = { TopicName: "topic-1" };
    const desired2: Record<string, unknown> = {
      TopicName: "topic-2",
      // One of them carries the sentinel — should still substitute.
      [CfnKey.KMS_MASTER_KEY_ID]: SNS_AWS_MANAGED_LITERAL,
    };

    const r1 = await ensureSnsDefaultKms(baseState(), desired1);
    const r2 = await ensureSnsDefaultKms(baseState(), desired2);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Helper invoked once per topic. The upstream alias-resolver
    // caches by (accountId, region) — verified in D-0 tests. Here we
    // assert the helper itself doesn't double-call within a single
    // invocation and that both topics end up with the resolved
    // alias-name (the sentinel one was upgraded).
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
    expect(desired1[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired2[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D3-7 (runId set): forwards runId to the resolver opts", async () => {
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    await ensureSnsDefaultKms(
      baseState({ runId: "run-d3-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d3-runid-test" }),
    );
  });

  it("AC-D3-7 (runId absent): does NOT forward an undefined runId key", async () => {
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    await ensureSnsDefaultKms(baseState({ runId: undefined }), desired);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D3-2 (form choice): substituted value equals aliasName, NEVER keyArn", async () => {
    // Belt-and-braces: a dedicated assertion for the load-bearing
    // form choice. SNS accepts both forms; this hook always threads
    // the alias name to keep desiredState audit-friendly.
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    await ensureSnsDefaultKms(baseState(), desired);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired[CfnKey.KMS_MASTER_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("I-D3-4 (pollution discipline): no audit records emitted by this module directly", async () => {
    const desired: Record<string, unknown> = {
      TopicName: "assignee-sns-topic-deadbeef",
    };
    await ensureSnsDefaultKms(baseState(), desired);
    // Underlying resolver is mocked → real audit-log code never reached.
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
