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

vi.mock("../../../audit/audit-log.js", () => ({
  appendAuditRecord: mockAppendAuditRecord,
}));

import { ensureSecretsManagerDefaultKms } from "./secretsmanager-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

type StateOverrides = Partial<Omit<AgentState, "runId">> & { runId?: string };

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d4-001",
    resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureSecretsManagerDefaultKms", () => {
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

  it("AC-D4-1: substitutes resolved alias-name into KmsKeyId when absent", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    // I-D4-2: NEVER the keyArn form for SecretsManager.
    expect(desired[CfnKey.KMS_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D4-2: user-supplied CMK ARN — resolver NOT invoked, value preserved", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired: Record<string, unknown> = {
      Name: "my-secret",
      [CfnKey.KMS_KEY_ID]: userArn,
    };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(userArn);
  });

  it("AC-D4-2: user-supplied custom alias — preserved verbatim", async () => {
    const userAlias = "alias/my-team-secrets";
    const desired: Record<string, unknown> = {
      Name: "my-secret",
      [CfnKey.KMS_KEY_ID]: userAlias,
    };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(userAlias);
  });

  it("AC-D4-2 (escape hatch): user-supplied AWS-managed shorthand `aws/secretsmanager` — preserved verbatim", async () => {
    const desired: Record<string, unknown> = {
      Name: "my-secret",
      [CfnKey.KMS_KEY_ID]: "aws/secretsmanager",
    };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe("aws/secretsmanager");
  });

  it("AC-D4-2 (whitespace edge): empty / whitespace KmsKeyId is treated as missing", async () => {
    const desired: Record<string, unknown> = {
      Name: "my-secret",
      [CfnKey.KMS_KEY_ID]: "   ",
    };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D4-3: non-SecretsManager resource — no-op, zero calls", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    const r = await ensureSecretsManagerDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D4-4: resolver throws Error → fail-closed with structured errorMessage", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = { Name: "my-secret" };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain(
        "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error",
      );
      // I-D4-3: error message names the AWS-managed escape hatch.
      expect(r.errorMessage).toContain("aws/secretsmanager");
      // Also names the alias / ARN escape hatches.
      expect(r.errorMessage).toContain("alias/<name>");
      expect(r.errorMessage).toContain("CMK ARN");
    }
    // CCAPI substitution must NOT have happened.
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D4-4: resolver throws non-Error → falls back to String(err)", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce("plain string failure");
    const desired: Record<string, unknown> = { Name: "my-secret" };
    const r = await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("plain string failure");
    }
  });

  it("AC-D4-5: 2 SecretsManager secrets in one apply — resolver called once per call (cache hit on the second)", async () => {
    const desiredA: Record<string, unknown> = { Name: "secret-a" };
    const desiredB: Record<string, unknown> = { Name: "secret-b" };
    const stateA = baseState({ runId: "run-d4-cache-a" });
    const stateB = baseState({ runId: "run-d4-cache-b" });

    const rA = await ensureSecretsManagerDefaultKms(stateA, desiredA);
    const rB = await ensureSecretsManagerDefaultKms(stateB, desiredB);

    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(desiredA[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desiredB[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    // The helper itself calls the upstream resolver once per invocation.
    // The (accountId, region) cache lives in the upstream resolver and
    // is verified at that boundary in apply-time-kms-resolver.test.ts.
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
  });

  it("AC-D4-6: passes runId through to the resolver opts when state.runId is set", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    await ensureSecretsManagerDefaultKms(
      baseState({ runId: "run-d4-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d4-runid-test" }),
    );
  });

  it("AC-D4-6 (absent runId): does NOT forward an undefined runId key", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    await ensureSecretsManagerDefaultKms(
      baseState({ runId: undefined }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D4-2 (form choice): substituted value is alias-name, never keyArn", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired[CfnKey.KMS_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
    expect((desired[CfnKey.KMS_KEY_ID] as string).startsWith("alias/")).toBe(
      true,
    );
  });

  it("I-D4-4 (pollution discipline): no audit records emitted by this module directly", async () => {
    const desired: Record<string, unknown> = { Name: "my-secret" };
    await ensureSecretsManagerDefaultKms(baseState(), desired);
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
