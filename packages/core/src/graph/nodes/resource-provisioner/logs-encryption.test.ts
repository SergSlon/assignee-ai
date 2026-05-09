import { describe, it, expect, vi, beforeEach } from "vitest";
import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";

const { mockResolveDefaultKms, mockAppendAuditRecord, mockKmsSend } =
  vi.hoisted(() => ({
    mockResolveDefaultKms: vi.fn(),
    mockAppendAuditRecord: vi.fn().mockResolvedValue(undefined),
    mockKmsSend: vi.fn(),
  }));

vi.mock("@/services/apply-time-kms-resolver.js", () => ({
  resolveDefaultKmsKeyForApply: mockResolveDefaultKms,
}));

vi.mock("../../../audit/audit-log.js", () => ({
  appendAuditRecord: mockAppendAuditRecord,
}));

vi.mock("@aws-sdk/client-kms", () => {
  class KMSClient {
    send = mockKmsSend;
    destroy = vi.fn();
  }
  function GetKeyPolicyCommand(input: unknown) {
    return { _type: "GetKeyPolicyCommand", input };
  }
  function PutKeyPolicyCommand(input: unknown) {
    return { _type: "PutKeyPolicyCommand", input };
  }
  return { KMSClient, GetKeyPolicyCommand, PutKeyPolicyCommand };
});

import { ensureLogsDefaultKms, clearLogsKmsCache } from "./logs-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

type StateOverrides = Partial<Omit<AgentState, "runId">> & { runId?: string };

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d6-001",
    resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
    ...overrides,
  } as unknown as AgentState;
}

const ROOT_POLICY_JSON = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "Enable IAM User Permissions",
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::112233445566:root" },
      Action: "kms:*",
      Resource: "*",
    },
  ],
});

function policyWithLogsGrant(servicePrincipal: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Enable IAM User Permissions",
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::112233445566:root" },
        Action: "kms:*",
        Resource: "*",
      },
      {
        Sid: "AssigneeGrantCloudWatchLogs",
        Effect: "Allow",
        Principal: { Service: servicePrincipal },
        Action: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        Resource: "*",
      },
    ],
  });
}

describe("ensureLogsDefaultKms", () => {
  beforeEach(() => {
    mockResolveDefaultKms.mockReset();
    mockAppendAuditRecord.mockReset();
    mockKmsSend.mockReset();
    clearLogsKmsCache();
    mockResolveDefaultKms.mockResolvedValue({
      keyArn: RESOLVED_KEY_ARN,
      aliasName: RESOLVED_ALIAS,
      created: false,
      accountId: "112233445566",
    });
  });

  it("AC-D6-1: substitutes resolved key ARN and adds Logs grant when policy lacks it", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON }) // GetKeyPolicy
      .mockResolvedValueOnce({}); // PutKeyPolicy
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    // I-D6-2: KEY ARN form, NEVER alias.
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    expect(desired[CfnKey.KMS_KEY_ID]).not.toBe(RESOLVED_ALIAS);
    // GetKeyPolicy + PutKeyPolicy both called.
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    expect((mockKmsSend.mock.calls[0]?.[0] as { _type: string })._type).toBe(
      "GetKeyPolicyCommand",
    );
    expect((mockKmsSend.mock.calls[1]?.[0] as { _type: string })._type).toBe(
      "PutKeyPolicyCommand",
    );
    // PutKeyPolicy payload includes our new statement.
    const putInput = (
      mockKmsSend.mock.calls[1]?.[0] as {
        input: { KeyId: string; PolicyName: string; Policy: string };
      }
    ).input;
    expect(putInput.KeyId).toBe(RESOLVED_KEY_ARN);
    expect(putInput.PolicyName).toBe("default");
    const newPolicy = JSON.parse(putInput.Policy);
    const grantStmt = newPolicy.Statement.find(
      (s: { Sid?: string }) => s.Sid === "AssigneeGrantCloudWatchLogs",
    );
    expect(grantStmt).toBeDefined();
    expect(grantStmt.Principal.Service).toBe("logs.us-east-1.amazonaws.com");
    expect(grantStmt.Action).toEqual(
      expect.arrayContaining([
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ]),
    );
  });

  it("AC-D6-2: idempotent — when policy already has Logs grant, does NOT call PutKeyPolicy", async () => {
    mockKmsSend.mockResolvedValueOnce({
      Policy: policyWithLogsGrant("logs.us-east-1.amazonaws.com"),
    });
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    // Only GetKeyPolicy was called, NOT PutKeyPolicy.
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    expect((mockKmsSend.mock.calls[0]?.[0] as { _type: string })._type).toBe(
      "GetKeyPolicyCommand",
    );
  });

  it("AC-D6-2 (cache reuse): two LogGroups in one apply share one GetKeyPolicy + PutKeyPolicy", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desiredA: Record<string, unknown> = { LogGroupName: "/a" };
    const desiredB: Record<string, unknown> = { LogGroupName: "/b" };
    const rA = await ensureLogsDefaultKms(baseState(), desiredA);
    const rB = await ensureLogsDefaultKms(baseState(), desiredB);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(desiredA[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    expect(desiredB[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    // Resolver called twice (once per helper invocation).
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
    // KMS GetKeyPolicy + PutKeyPolicy called ONCE total — second
    // invocation skipped via the policyGrantCache.
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("AC-D6-3: user-supplied KmsKeyId — resolver NOT invoked, value preserved, NO policy ensure", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired: Record<string, unknown> = {
      LogGroupName: "/test/group",
      [CfnKey.KMS_KEY_ID]: userArn,
    };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(userArn);
  });

  it("AC-D6-3 (whitespace edge): empty / whitespace KmsKeyId is treated as missing", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = {
      LogGroupName: "/test/group",
      [CfnKey.KMS_KEY_ID]: "   ",
    };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
  });

  it("AC-D6-4: non-Logs resource — no-op, zero calls", async () => {
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D6-5: resolver throws → fail-closed; KMS NOT called", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain("CloudWatch Logs encryption");
      expect(r.errorMessage).toContain("logs.<region>.amazonaws.com");
    }
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D6-6: GetKeyPolicy throws → fail-closed with structured errorMessage; PutKeyPolicy NOT called", async () => {
    mockKmsSend.mockRejectedValueOnce(
      new Error("AccessDeniedException: kms:GetKeyPolicy denied"),
    );
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to grant logs.us-east-1.amazonaws.com access",
      );
      expect(r.errorMessage).toContain("kms:GetKeyPolicy");
      expect(r.errorMessage).toContain("kms:PutKeyPolicy");
    }
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D6-6: PutKeyPolicy throws → fail-closed; KmsKeyId not substituted", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockRejectedValueOnce(
        new Error("MalformedPolicyDocumentException: bad policy"),
      );
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("Failed to grant");
      expect(r.errorMessage).toContain("MalformedPolicyDocumentException");
    }
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    expect(desired[CfnKey.KMS_KEY_ID]).toBeUndefined();
  });

  it("AC-D6-7: GetKeyPolicy returns empty policy → fail-closed", async () => {
    mockKmsSend.mockResolvedValueOnce({ Policy: "" });
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("Failed to grant");
      expect(r.errorMessage).toContain("returned an empty policy");
    }
  });

  it("AC-D6-8: Sid match alone short-circuits the grant check", async () => {
    // Policy has the Sid but with NO matching service principal — the
    // helper should still treat this as "already granted" because the
    // Sid is the canonical "Assignee owns this statement" marker.
    const policyWithAssigneeSid = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Enable IAM User Permissions",
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::112233445566:root" },
          Action: "kms:*",
          Resource: "*",
        },
        {
          Sid: "AssigneeGrantCloudWatchLogs",
          Effect: "Allow",
          Principal: { Service: "some.other.service" },
          Action: ["kms:Decrypt"],
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithAssigneeSid });
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    expect(mockKmsSend).toHaveBeenCalledTimes(1); // GetKeyPolicy only.
  });

  it("AC-D6-9: third-party policy with logs principal in Service ARRAY is detected as already granted", async () => {
    const policyWithArrayPrincipal = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Enable IAM User Permissions",
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::112233445566:root" },
          Action: "kms:*",
          Resource: "*",
        },
        {
          Sid: "OperatorOwnedLogsGrant",
          Effect: "Allow",
          Principal: {
            Service: ["logs.us-east-1.amazonaws.com", "events.amazonaws.com"],
          },
          Action: "kms:Encrypt*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithArrayPrincipal });
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockKmsSend).toHaveBeenCalledTimes(1); // No PutKeyPolicy — already granted.
  });

  it("AC-D6-10: passes runId through to the resolver opts when set", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    await ensureLogsDefaultKms(
      baseState({ runId: "run-d6-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d6-runid-test" }),
    );
  });

  it("AC-D6-10 (absent runId): does NOT forward an undefined runId key", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    await ensureLogsDefaultKms(baseState({ runId: undefined }), desired);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("AC-D6-9 (kms:* wildcard): existing kms:* grant on logs principal is detected as already-granted (no PutKeyPolicy)", async () => {
    const policyWithWildcardAction = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Enable IAM User Permissions",
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::112233445566:root" },
          Action: "kms:*",
          Resource: "*",
        },
        {
          Sid: "OperatorBroadLogsGrant",
          Effect: "Allow",
          Principal: { Service: "logs.us-east-1.amazonaws.com" },
          Action: "kms:*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithWildcardAction });
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    // Only GetKeyPolicy was called (1) — kms:* wildcard short-circuits.
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-D6-9 (Deny effect): explicit Deny statement on logs principal does NOT short-circuit; PutKeyPolicy fires", async () => {
    // An operator-authored Deny statement should NOT be treated as
    // satisfying the grant — Deny wins in AWS resolution but our
    // pre-hook should still install the canonical Allow so the
    // operator's intent (Deny) is visible alongside ours.
    const policyWithDenyOnLogs = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Enable IAM User Permissions",
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::112233445566:root" },
          Action: "kms:*",
          Resource: "*",
        },
        {
          Sid: "OperatorDenyLogs",
          Effect: "Deny",
          Principal: { Service: "logs.us-east-1.amazonaws.com" },
          Action: "kms:Encrypt*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend
      .mockResolvedValueOnce({ Policy: policyWithDenyOnLogs })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    const r = await ensureLogsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KMS_KEY_ID]).toBe(RESOLVED_KEY_ARN);
    // Both GetKeyPolicy + PutKeyPolicy fire (2) — Deny does NOT count as Allow.
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("I-D6-5 (pollution discipline): no audit records emitted by this module directly", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { LogGroupName: "/test/group" };
    await ensureLogsDefaultKms(baseState(), desired);
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
