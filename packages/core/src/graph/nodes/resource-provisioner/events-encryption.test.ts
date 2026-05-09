import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
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

import {
  ensureEventsDefaultKms,
  clearEventsKmsCache,
  EVENTS_GRANT_SID,
} from "./events-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

type StateOverrides = Partial<Omit<AgentState, "runId">> & { runId?: string };

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d7-001",
    resourceType: RESOURCE_TYPES.EVENTS_EVENT_BUS,
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

describe("ensureEventsDefaultKms", () => {
  beforeEach(() => {
    mockResolveDefaultKms.mockReset();
    mockAppendAuditRecord.mockReset();
    mockKmsSend.mockReset();
    clearEventsKmsCache();
    mockResolveDefaultKms.mockResolvedValue({
      keyArn: RESOLVED_KEY_ARN,
      aliasName: RESOLVED_ALIAS,
      created: false,
      accountId: "112233445566",
    });
  });

  it("AC-D7-1: substitutes alias name and adds events.amazonaws.com grant when policy lacks it", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    // I-D7-2: ALIAS-NAME form, NEVER keyArn.
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(desired["KmsKeyIdentifier"]).not.toBe(RESOLVED_KEY_ARN);
    // GetKeyPolicy + PutKeyPolicy both called.
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    // PutKeyPolicy payload includes the EventBridge grant statement.
    const putInput = (
      mockKmsSend.mock.calls[1]?.[0] as {
        input: { KeyId: string; PolicyName: string; Policy: string };
      }
    ).input;
    expect(putInput.KeyId).toBe(RESOLVED_KEY_ARN);
    const newPolicy = JSON.parse(putInput.Policy);
    const grantStmt = newPolicy.Statement.find(
      (s: { Sid?: string }) => s.Sid === EVENTS_GRANT_SID,
    );
    expect(grantStmt).toBeDefined();
    // Region-AGNOSTIC service principal (events.amazonaws.com, NOT
    // events.us-east-1.amazonaws.com).
    expect(grantStmt.Principal.Service).toBe("events.amazonaws.com");
  });

  it("AC-D7-2: idempotent — when policy already has events.amazonaws.com grant, does NOT call PutKeyPolicy", async () => {
    const policyWithEventsGrant = JSON.stringify({
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
          Sid: EVENTS_GRANT_SID,
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
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
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithEventsGrant });
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(mockKmsSend).toHaveBeenCalledTimes(1); // GetKeyPolicy only.
  });

  it("AC-D7-2 (cache reuse): two EventBus in one apply share one GetKeyPolicy + PutKeyPolicy", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desiredA: Record<string, unknown> = { Name: "bus-a" };
    const desiredB: Record<string, unknown> = { Name: "bus-b" };
    const rA = await ensureEventsDefaultKms(baseState(), desiredA);
    const rB = await ensureEventsDefaultKms(baseState(), desiredB);
    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(desiredA["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(desiredB["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
    // Only ONE GetKeyPolicy + PutKeyPolicy total — second invocation
    // hit the shared service-principal-grant cache.
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("AC-D7-3: user-supplied KmsKeyIdentifier — resolver NOT invoked, value preserved, NO policy ensure", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired: Record<string, unknown> = {
      Name: "test-bus",
      KmsKeyIdentifier: userArn,
    };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBe(userArn);
  });

  it("AC-D7-3 (escape hatch): user-supplied alias/aws/events — preserved verbatim", async () => {
    const desired: Record<string, unknown> = {
      Name: "test-bus",
      KmsKeyIdentifier: "alias/aws/events",
    };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBe("alias/aws/events");
  });

  it("AC-D7-3 (whitespace edge): empty / whitespace KmsKeyIdentifier is treated as missing", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = {
      Name: "test-bus",
      KmsKeyIdentifier: "   ",
    };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D7-4: non-EventBus resource — no-op, zero calls", async () => {
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D7-5: resolver throws → fail-closed; KMS NOT called", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain("EventBridge EventBus encryption");
      expect(r.errorMessage).toContain("alias/aws/events");
    }
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D7-6: GetKeyPolicy throws → fail-closed with structured errorMessage", async () => {
    mockKmsSend.mockRejectedValueOnce(
      new Error("AccessDeniedException: kms:GetKeyPolicy denied"),
    );
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to grant events.amazonaws.com access",
      );
      expect(r.errorMessage).toContain("kms:GetKeyPolicy");
      expect(r.errorMessage).toContain("kms:PutKeyPolicy");
    }
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D7-6: PutKeyPolicy throws → fail-closed; KmsKeyIdentifier not substituted", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockRejectedValueOnce(new Error("MalformedPolicyDocumentException"));
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("Failed to grant");
      expect(r.errorMessage).toContain("MalformedPolicyDocumentException");
    }
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D7-7: Sid match short-circuits even with non-matching service principal", async () => {
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
          Sid: EVENTS_GRANT_SID,
          Effect: "Allow",
          Principal: { Service: "some.other.service" },
          Action: ["kms:Decrypt"],
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithAssigneeSid });
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-D7-8: existing kms:* wildcard grant on events principal is detected (no PutKeyPolicy)", async () => {
    const policyWithWildcardAction = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OperatorBroadEventsGrant",
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "kms:*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: policyWithWildcardAction });
    const desired: Record<string, unknown> = { Name: "test-bus" };
    const r = await ensureEventsDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-D7-9: passes runId through to the resolver opts when set", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-bus" };
    await ensureEventsDefaultKms(
      baseState({ runId: "run-d7-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d7-runid-test" }),
    );
  });

  it("AC-D7-9 (absent runId): does NOT forward an undefined runId key", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-bus" };
    await ensureEventsDefaultKms(baseState({ runId: undefined }), desired);
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("I-D7-5 (pollution discipline): no audit records emitted by this module directly", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-bus" };
    await ensureEventsDefaultKms(baseState(), desired);
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
