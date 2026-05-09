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

import { ensureEfsDefaultKms } from "./efs-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

type StateOverrides = Partial<Omit<AgentState, "runId">> & { runId?: string };

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d5-001",
    resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureEfsDefaultKms", () => {
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

  it("AC-D5-1: substitutes resolved alias-name into KmsKeyId when Encrypted=true and KmsKeyId absent", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    // I-D5-2: NEVER the keyArn form for EFS.
    expect(desired[CfnKey.KMS_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D5-2: user-supplied CMK ARN — resolver NOT invoked, value preserved", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
      [CfnKey.KMS_KEY_ID]: userArn,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(userArn);
  });

  it("AC-D5-2: user-supplied custom alias — preserved verbatim", async () => {
    const userAlias = "alias/my-team-data";
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
      [CfnKey.KMS_KEY_ID]: userAlias,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(userAlias);
  });

  it("AC-D5-2 (escape hatch): user-supplied AWS-managed alias `alias/aws/elasticfilesystem` — preserved verbatim", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
      [CfnKey.KMS_KEY_ID]: "alias/aws/elasticfilesystem",
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe("alias/aws/elasticfilesystem");
  });

  it("AC-D5-2 (whitespace edge): empty / whitespace KmsKeyId is treated as missing", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
      [CfnKey.KMS_KEY_ID]: "   ",
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D5-3: non-EFS resource — no-op, zero calls", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
    };
    const r = await ensureEfsDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D5-4 (Encrypted=false skip): hook is no-op, KmsKeyId stays absent", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: false,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D5-4 (Encrypted absent): hook is no-op (treats absent as not-Encrypted)", async () => {
    const desired: Record<string, unknown> = {};
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it('AC-D5-4 (Encrypted truthy-not-true): string `"true"` does NOT trigger substitution (strict-eq contract)', async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: "true",
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D5-5: resolver throws Error → fail-closed with structured errorMessage", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain(
        "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error",
      );
      // I-D5-3: error message names the AWS-managed escape hatch.
      expect(r.errorMessage).toContain("alias/aws/elasticfilesystem");
      expect(r.errorMessage).toContain("alias/<name>");
      expect(r.errorMessage).toContain("CMK ARN");
      // Encrypted: false workaround mentioned (with BP-EFS-001 warning).
      expect(r.errorMessage).toContain("Encrypted: false");
      expect(r.errorMessage).toContain("BP-EFS-001");
    }
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D5-5: resolver throws non-Error → falls back to String(err)", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce("plain string failure");
    const desired: Record<string, unknown> = {
      [CfnKey.ENCRYPTED]: true,
    };
    const r = await ensureEfsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("plain string failure");
    }
  });

  it("AC-D5-6: 2 EFS file systems in one apply — resolver called once per call", async () => {
    const desiredA: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    const desiredB: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    const stateA = baseState({ runId: "run-d5-cache-a" });
    const stateB = baseState({ runId: "run-d5-cache-b" });

    const rA = await ensureEfsDefaultKms(stateA, desiredA);
    const rB = await ensureEfsDefaultKms(stateB, desiredB);

    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(desiredA[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desiredB[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
  });

  it("AC-D5-7: passes runId through to the resolver opts when state.runId is set", async () => {
    const desired: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    await ensureEfsDefaultKms(
      baseState({ runId: "run-d5-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d5-runid-test" }),
    );
  });

  it("AC-D5-7 (absent runId): does NOT forward an undefined runId key", async () => {
    const desired: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    await ensureEfsDefaultKms(baseState({ runId: undefined }), desired);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D5-2 (form choice): substituted value is alias-name, never keyArn", async () => {
    const desired: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    await ensureEfsDefaultKms(baseState(), desired);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_ALIAS);
    expect(desired[CfnKey.KMS_KEY_ID]).not.toBe(RESOLVED_KEY_ARN);
    expect((desired[CfnKey.KMS_KEY_ID] as string).startsWith("alias/")).toBe(
      true,
    );
  });

  it("I-D5-4 (pollution discipline): no audit records emitted by this module directly", async () => {
    const desired: Record<string, unknown> = { [CfnKey.ENCRYPTED]: true };
    await ensureEfsDefaultKms(baseState(), desired);
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
