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

// Pollution discipline (Wave B-1 hard lesson) — even though the test's primary
// mock prevents the helper reaching audit-log code, mock the audit-log module
// belt-and-braces in case any indirect path emits.
vi.mock("../../../audit/audit-log.js", () => ({
  appendAuditRecord: mockAppendAuditRecord,
}));

import { ensureS3DefaultKms } from "./s3-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:111122223333:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-d1-001",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    ...overrides,
  } as unknown as AgentState;
}

function ssEncryption(
  rules: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    [CfnKey.BUCKET_ENCRYPTION]: {
      ServerSideEncryptionConfiguration: rules,
    },
  };
}

describe("ensureS3DefaultKms", () => {
  beforeEach(() => {
    mockResolveDefaultKms.mockReset();
    mockAppendAuditRecord.mockReset();
    mockResolveDefaultKms.mockResolvedValue({
      keyArn: RESOLVED_KEY_ARN,
      aliasName: RESOLVED_ALIAS,
      created: false,
      accountId: "111122223333",
    });
  });

  it("AC-D1-1: substitutes resolved keyArn into SSE-KMS rule lacking KMSMasterKeyID", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const rule0 = (
      (desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>)[
        "ServerSideEncryptionConfiguration"
      ] as Array<Record<string, unknown>>
    )[0]!;
    const sseDefault = rule0["ServerSideEncryptionByDefault"] as Record<
      string,
      unknown
    >;
    expect(sseDefault["KMSMasterKeyID"]).toBe(RESOLVED_KEY_ARN);
    // I-D1-2: never the alias-form for S3.
    expect(sseDefault["KMSMasterKeyID"]).not.toBe(RESOLVED_ALIAS);
  });

  it("AC-D1-2: user-supplied KMSMasterKeyID wins verbatim — resolver NOT invoked", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: "aws:kms",
          KMSMasterKeyID: userArn,
        },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    const sseDefault = (
      (desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>)[
        "ServerSideEncryptionConfiguration"
      ] as Array<Record<string, unknown>>
    )[0]!["ServerSideEncryptionByDefault"] as Record<string, unknown>;
    expect(sseDefault["KMSMasterKeyID"]).toBe(userArn);
  });

  it("AC-D1-2 (whitespace edge): empty / whitespace KMSMasterKeyID is treated as missing", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: "aws:kms",
          KMSMasterKeyID: "   ",
        },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const sseDefault = (
      (desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>)[
        "ServerSideEncryptionConfiguration"
      ] as Array<Record<string, unknown>>
    )[0]!["ServerSideEncryptionByDefault"] as Record<string, unknown>;
    expect(sseDefault["KMSMasterKeyID"]).toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D1-3: SSE-S3 (AES-256) path — resolver NOT invoked", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
  });

  it("AC-D1-4: non-S3 resource — no-op, zero calls", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    const r = await ensureS3DefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
  });

  it("AC-D1-5: bucket without BucketEncryption — no-op", async () => {
    const desired: Record<string, unknown> = { BucketName: "test-bucket" };
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
  });

  it("AC-D1-5 (empty SSEConfiguration): no-op", async () => {
    const desired = ssEncryption([]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
  });

  it("AC-D1-6: resolver throws → fail-closed with structured errorMessage", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain(
        "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error",
      );
      // Actionable hint present so operator knows the escape hatch.
      expect(r.errorMessage).toContain("KMSMasterKeyID");
    }
    // CCAPI substitution must NOT have happened.
    const sseDefault = (
      (desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>)[
        "ServerSideEncryptionConfiguration"
      ] as Array<Record<string, unknown>>
    )[0]!["ServerSideEncryptionByDefault"] as Record<string, unknown>;
    expect(sseDefault["KMSMasterKeyID"]).toBeUndefined();
  });

  it("AC-D1-7: resolver throws non-Error — falls back to String(err) in message", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce("plain string failure");
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("plain string failure");
    }
  });

  it("AC-D1-8: multiple SSE-KMS rules in one bucket — resolver called once, all rules substituted", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const rules = (
      desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>
    )["ServerSideEncryptionConfiguration"] as Array<Record<string, unknown>>;
    for (const rule of rules) {
      const sseDefault = rule["ServerSideEncryptionByDefault"] as Record<
        string,
        unknown
      >;
      expect(sseDefault["KMSMasterKeyID"]).toBe(RESOLVED_KEY_ARN);
    }
  });

  it("AC-D1-8 (mixed): one SSE-KMS-needing-default + one user-supplied + one SSE-S3 — resolver called once, only the missing-key rule substituted", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user";
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
      {
        ServerSideEncryptionByDefault: {
          SSEAlgorithm: "aws:kms",
          KMSMasterKeyID: userArn,
        },
      },
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" },
      },
    ]);
    const r = await ensureS3DefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const rules = (
      desired[CfnKey.BUCKET_ENCRYPTION] as Record<string, unknown>
    )["ServerSideEncryptionConfiguration"] as Array<Record<string, unknown>>;
    expect(
      (rules[0]!["ServerSideEncryptionByDefault"] as Record<string, unknown>)[
        "KMSMasterKeyID"
      ],
    ).toBe(RESOLVED_KEY_ARN);
    expect(
      (rules[1]!["ServerSideEncryptionByDefault"] as Record<string, unknown>)[
        "KMSMasterKeyID"
      ],
    ).toBe(userArn);
    // SSE-S3 rule: KMSMasterKeyID stays absent.
    expect(
      (rules[2]!["ServerSideEncryptionByDefault"] as Record<string, unknown>)[
        "KMSMasterKeyID"
      ],
    ).toBeUndefined();
  });

  it("AC-D1-9: passes runId through to the resolver opts when state.runId is set", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    await ensureS3DefaultKms(
      baseState({ runId: "run-d1-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d1-runid-test" }),
    );
  });

  it("AC-D1-9 (absent runId): does NOT forward an undefined runId key", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    await ensureS3DefaultKms(
      baseState({ runId: undefined as unknown as string }),
      desired,
    );
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D1-4 (pollution discipline): no audit records emitted by this module directly", async () => {
    const desired = ssEncryption([
      {
        ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
      },
    ]);
    await ensureS3DefaultKms(baseState(), desired);
    // Underlying resolver is mocked → real audit-log code never reached.
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
