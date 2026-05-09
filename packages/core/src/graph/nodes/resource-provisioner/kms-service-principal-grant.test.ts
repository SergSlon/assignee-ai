import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockKmsSend } = vi.hoisted(() => ({ mockKmsSend: vi.fn() }));

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
  ensureServicePrincipalGrant,
  clearKmsServicePrincipalGrantCache,
} from "./kms-service-principal-grant.js";
import { KMSClient } from "@aws-sdk/client-kms";

const KEY_ARN = "arn:aws:kms:us-east-1:112233445566:key/abc-def-1234";
const REGION = "us-east-1";

const CANONICAL_ACTIONS = [
  "kms:Encrypt*",
  "kms:Decrypt*",
  "kms:ReEncrypt*",
  "kms:GenerateDataKey*",
  "kms:Describe*",
] as const;

const ROOT_POLICY = JSON.stringify({
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

function client(): KMSClient {
  return new KMSClient({ region: REGION });
}

describe("ensureServicePrincipalGrant", () => {
  beforeEach(() => {
    mockKmsSend.mockReset();
    clearKmsServicePrincipalGrantCache();
  });

  it("AC-1: missing grant — calls Get + Put with new statement", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY })
      .mockResolvedValueOnce({});
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    const putInput = (
      mockKmsSend.mock.calls[1]?.[0] as {
        input: { Policy: string };
      }
    ).input;
    const policy = JSON.parse(putInput.Policy);
    const stmt = policy.Statement.find(
      (s: { Sid?: string }) => s.Sid === "AssigneeGrantTest",
    );
    expect(stmt.Principal.Service).toBe("logs.us-east-1.amazonaws.com");
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Action).toEqual(expect.arrayContaining([...CANONICAL_ACTIONS]));
  });

  it("AC-2: idempotent — second call same triple hits cache (zero KMS calls)", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY })
      .mockResolvedValueOnce({});
    const opts = {
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    };
    await ensureServicePrincipalGrant(opts);
    await ensureServicePrincipalGrant(opts);
    expect(mockKmsSend).toHaveBeenCalledTimes(2); // Only the first call's Get+Put.
  });

  it("AC-3: different service-principal on same key triggers separate Get+Put", async () => {
    // First call: logs principal.
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY })
      .mockResolvedValueOnce({});
    // Second call: events principal — re-fetches policy + re-puts.
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY })
      .mockResolvedValueOnce({});

    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantLogs",
      canonicalActions: CANONICAL_ACTIONS,
    });
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "events.amazonaws.com",
      sid: "AssigneeGrantEvents",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(4); // 2 × (Get + Put).
  });

  it("AC-4: existing matching statement → idempotent skip (Get only, no Put)", async () => {
    const existingPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AssigneeGrantTest",
          Effect: "Allow",
          Principal: { Service: "logs.us-east-1.amazonaws.com" },
          Action: ["kms:Encrypt*"],
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: existingPolicy });
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-5: empty policy → throws structured error", async () => {
    mockKmsSend.mockResolvedValueOnce({ Policy: "" });
    await expect(
      ensureServicePrincipalGrant({
        kms: client(),
        keyArn: KEY_ARN,
        region: REGION,
        servicePrincipal: "logs.us-east-1.amazonaws.com",
        sid: "AssigneeGrantTest",
        canonicalActions: CANONICAL_ACTIONS,
      }),
    ).rejects.toThrow(/empty policy/);
  });

  it("AC-6: kms:* wildcard short-circuits the grant check", async () => {
    const wildcardPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OperatorBroad",
          Effect: "Allow",
          Principal: { Service: "logs.us-east-1.amazonaws.com" },
          Action: "kms:*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: wildcardPolicy });
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-7: Deny effect on principal does NOT short-circuit; Put still fires", async () => {
    const denyPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OperatorDeny",
          Effect: "Deny",
          Principal: { Service: "logs.us-east-1.amazonaws.com" },
          Action: "kms:Encrypt*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend
      .mockResolvedValueOnce({ Policy: denyPolicy })
      .mockResolvedValueOnce({});
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "logs.us-east-1.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
  });

  it("AC-8: Service principal in array form is detected", async () => {
    const arrayPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "OperatorArrayPrincipals",
          Effect: "Allow",
          Principal: {
            Service: ["logs.us-east-1.amazonaws.com", "events.amazonaws.com"],
          },
          Action: "kms:Encrypt*",
          Resource: "*",
        },
      ],
    });
    mockKmsSend.mockResolvedValueOnce({ Policy: arrayPolicy });
    await ensureServicePrincipalGrant({
      kms: client(),
      keyArn: KEY_ARN,
      region: REGION,
      servicePrincipal: "events.amazonaws.com",
      sid: "AssigneeGrantTest",
      canonicalActions: CANONICAL_ACTIONS,
    });
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
  });

  it("AC-9: PutKeyPolicy throws → propagates (caller wraps)", async () => {
    mockKmsSend
      .mockResolvedValueOnce({ Policy: ROOT_POLICY })
      .mockRejectedValueOnce(new Error("MalformedPolicyDocumentException"));
    await expect(
      ensureServicePrincipalGrant({
        kms: client(),
        keyArn: KEY_ARN,
        region: REGION,
        servicePrincipal: "logs.us-east-1.amazonaws.com",
        sid: "AssigneeGrantTest",
        canonicalActions: CANONICAL_ACTIONS,
      }),
    ).rejects.toThrow(/MalformedPolicyDocumentException/);
  });
});
