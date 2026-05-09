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
  ensureEventsConnectionDefaultKms,
  clearEventsConnectionKmsCache,
  EVENTS_CONNECTION_GRANT_SID,
} from "./events-connection-encryption.js";

const RESOLVED_KEY_ARN =
  "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234-5678-9012";
const RESOLVED_ALIAS = "alias/assignee-default-encryption";

type StateOverrides = Partial<Omit<AgentState, "runId">> & { runId?: string };

function baseState(overrides: StateOverrides = {}): AgentState {
  return {
    runId: "run-d8-001",
    resourceType: RESOURCE_TYPES.EVENTS_CONNECTION,
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

describe("ensureEventsConnectionDefaultKms", () => {
  beforeEach(() => {
    mockResolveDefaultKms.mockReset();
    mockAppendAuditRecord.mockReset();
    mockKmsSend.mockReset();
    clearEventsConnectionKmsCache();
    mockResolveDefaultKms.mockResolvedValue({
      keyArn: RESOLVED_KEY_ARN,
      aliasName: RESOLVED_ALIAS,
      created: false,
      accountId: "112233445566",
    });
  });

  it("AC-D8-1: substitutes alias name and adds events.amazonaws.com grant when policy lacks it", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(desired["KmsKeyIdentifier"]).not.toBe(RESOLVED_KEY_ARN);
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    const putInput = (
      mockKmsSend.mock.calls[1]?.[0] as {
        input: { Policy: string };
      }
    ).input;
    const newPolicy = JSON.parse(putInput.Policy);
    const grantStmt = newPolicy.Statement.find(
      (s: { Sid?: string }) => s.Sid === EVENTS_CONNECTION_GRANT_SID,
    );
    expect(grantStmt).toBeDefined();
    expect(grantStmt.Principal.Service).toBe("events.amazonaws.com");
  });

  it("AC-D8-2: idempotent — second call hits shared cache (no KMS calls)", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desiredA: Record<string, unknown> = { Name: "conn-a" };
    const desiredB: Record<string, unknown> = { Name: "conn-b" };
    await ensureEventsConnectionDefaultKms(baseState(), desiredA);
    await ensureEventsConnectionDefaultKms(baseState(), desiredB);
    expect(desiredA["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(desiredB["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(2);
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("AC-D8-3: user-supplied KmsKeyIdentifier — resolver NOT invoked", async () => {
    const userArn = "arn:aws:kms:us-east-1:999999999999:key/user-supplied-key";
    const desired: Record<string, unknown> = {
      Name: "test-conn",
      KmsKeyIdentifier: userArn,
    };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBe(userArn);
  });

  it("AC-D8-3 (escape hatch): user-supplied alias/aws/secretsmanager — preserved verbatim", async () => {
    const desired: Record<string, unknown> = {
      Name: "test-conn",
      KmsKeyIdentifier: "alias/aws/secretsmanager",
    };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBe("alias/aws/secretsmanager");
  });

  it("AC-D8-3 (whitespace): empty / whitespace KmsKeyIdentifier treated as missing", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = {
      Name: "test-conn",
      KmsKeyIdentifier: "   ",
    };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).toHaveBeenCalledTimes(1);
    expect(desired["KmsKeyIdentifier"]).toBe(RESOLVED_ALIAS);
  });

  it("AC-D8-4: non-Connection resource — no-op", async () => {
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(
      baseState({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockResolveDefaultKms).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D8-5: resolver throws → fail-closed; KMS NOT called", async () => {
    mockResolveDefaultKms.mockRejectedValueOnce(
      new Error("KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED: STS network error"),
    );
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain(
        "Failed to resolve default Assignee KMS CMK",
      );
      expect(r.errorMessage).toContain("EventBridge Connection encryption");
      expect(r.errorMessage).toContain("alias/aws/secretsmanager");
    }
    expect(mockKmsSend).not.toHaveBeenCalled();
  });

  it("AC-D8-6: GetKeyPolicy throws → fail-closed", async () => {
    mockKmsSend.mockRejectedValueOnce(
      new Error("AccessDeniedException: kms:GetKeyPolicy denied"),
    );
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("Failed to grant events.amazonaws.com");
      expect(r.errorMessage).toContain("Connection");
    }
    expect(desired["KmsKeyIdentifier"]).toBeUndefined();
  });

  it("AC-D8-6: PutKeyPolicy throws → fail-closed", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockRejectedValueOnce(new Error("MalformedPolicyDocumentException"));
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("MalformedPolicyDocumentException");
    }
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("AC-D8-7: passes runId through to the resolver opts", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-conn" };
    await ensureEventsConnectionDefaultKms(
      baseState({ runId: "run-d8-runid-test" }),
      desired,
    );
    expect(mockResolveDefaultKms.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ runId: "run-d8-runid-test" }),
    );
  });

  it("AC-D8-7 (absent runId): does NOT forward an undefined runId key", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-conn" };
    await ensureEventsConnectionDefaultKms(
      baseState({ runId: undefined }),
      desired,
    );
    const callArg = mockResolveDefaultKms.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect("runId" in callArg).toBe(false);
  });

  it("AC-D8-8: existing kms:* wildcard grant on events principal short-circuits", async () => {
    const wildcardPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OperatorBroad",
          Effect: "Allow",
          Principal: { Service: "events.amazonaws.com" },
          Action: "kms:*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: wildcardPolicy });
    const desired: Record<string, unknown> = { Name: "test-conn" };
    const r = await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("I-D8-5 (pollution discipline): no audit records emitted by this module directly", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY_JSON })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = { Name: "test-conn" };
    await ensureEventsConnectionDefaultKms(baseState(), desired);
    expect(mockAppendAuditRecord).not.toHaveBeenCalled();
  });
});
