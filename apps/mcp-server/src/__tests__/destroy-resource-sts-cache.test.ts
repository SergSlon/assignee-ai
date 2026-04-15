/**
 * Regression tests for P1-R2-1 — the STS operator-account cache in
 * destroy-resource.ts must not poison itself on a first-call failure.
 *
 * Before the fix, a single transient STS error permanently disabled the
 * cross-account NotFound guard for the MCP process lifetime because the
 * rejected Promise was cached. After the fix, failures do not cache and
 * the next call retries STS fresh.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock STS BEFORE importing the SUT so the module-level STSClient reference
// resolves to our fake.
const mockStsSend = vi.fn();
vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    send = mockStsSend;
  }
  function GetCallerIdentityCommand(input: Record<string, unknown>) {
    return { ...input, _type: "GetCallerIdentityCommand" };
  }
  return { STSClient, GetCallerIdentityCommand };
});

// Mock the other AWS SDKs the module imports so importing succeeds even
// though these tests don't exercise them.
vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class ResourceGroupsTaggingAPIClient {
    send = vi.fn();
  }
  function GetResourcesCommand(input: Record<string, unknown>) {
    return { ...input };
  }
  return { ResourceGroupsTaggingAPIClient, GetResourcesCommand };
});
vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class CloudControlClient {
    send = vi.fn();
  }
  return {
    CloudControlClient,
    DeleteResourceCommand: (i: Record<string, unknown>) => ({ ...i }),
    GetResourceRequestStatusCommand: (i: Record<string, unknown>) => ({ ...i }),
  };
});

import {
  __getOperatorAccountIdForTests,
  __resetOperatorAccountCacheForTests,
} from "../tools/destroy-resource.js";

const REAL_OPERATOR_ACCOUNT = "123456789012";
const REGION = "us-east-1";

describe("destroy-resource STS operator-account cache (P1-R2-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOperatorAccountCacheForTests();
    // Use realistic AKIA-shaped example credentials (AWS public docs example).
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  });

  afterEach(() => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
  });

  it("caches the account on success (second call skips STS)", async () => {
    mockStsSend.mockResolvedValueOnce({ Account: REAL_OPERATOR_ACCOUNT });

    const first = await __getOperatorAccountIdForTests(REGION);
    const second = await __getOperatorAccountIdForTests(REGION);

    expect(first).toBe(REAL_OPERATOR_ACCOUNT);
    expect(second).toBe(REAL_OPERATOR_ACCOUNT);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache on STS failure — next call retries", async () => {
    // First call: STS rejects with a real transient error shape.
    mockStsSend.mockRejectedValueOnce(
      Object.assign(new Error("Network failure connecting to STS"), {
        name: "NetworkingError",
        $metadata: { httpStatusCode: 0 },
      }),
    );
    // Second call: STS succeeds.
    mockStsSend.mockResolvedValueOnce({ Account: REAL_OPERATOR_ACCOUNT });

    const first = await __getOperatorAccountIdForTests(REGION);
    expect(first).toBeUndefined();

    const second = await __getOperatorAccountIdForTests(REGION);
    expect(second).toBe(REAL_OPERATOR_ACCOUNT);
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache when STS returns undefined Account", async () => {
    // Realistic case: GetCallerIdentity can return an empty Account when
    // creds are anonymous / SigV4 without a resolvable identity.
    mockStsSend.mockResolvedValueOnce({ Account: undefined });
    mockStsSend.mockResolvedValueOnce({ Account: REAL_OPERATOR_ACCOUNT });

    expect(await __getOperatorAccountIdForTests(REGION)).toBeUndefined();
    expect(await __getOperatorAccountIdForTests(REGION)).toBe(
      REAL_OPERATOR_ACCOUNT,
    );
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache on ExpiredToken (session-auth) errors", async () => {
    mockStsSend.mockRejectedValueOnce(
      Object.assign(
        new Error("The security token included in the request is expired"),
        {
          name: "ExpiredToken",
          $metadata: { httpStatusCode: 403 },
        },
      ),
    );
    mockStsSend.mockResolvedValueOnce({ Account: REAL_OPERATOR_ACCOUNT });

    expect(await __getOperatorAccountIdForTests(REGION)).toBeUndefined();
    expect(await __getOperatorAccountIdForTests(REGION)).toBe(
      REAL_OPERATOR_ACCOUNT,
    );
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });

  it("de-dupes concurrent in-flight lookups (single STS call for simultaneous callers)", async () => {
    let resolveSts!: (v: { Account: string }) => void;
    mockStsSend.mockReturnValueOnce(
      new Promise((r) => {
        resolveSts = r;
      }),
    );

    const p1 = __getOperatorAccountIdForTests(REGION);
    const p2 = __getOperatorAccountIdForTests(REGION);
    resolveSts({ Account: REAL_OPERATOR_ACCOUNT });

    expect(await p1).toBe(REAL_OPERATOR_ACCOUNT);
    expect(await p2).toBe(REAL_OPERATOR_ACCOUNT);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });
});
