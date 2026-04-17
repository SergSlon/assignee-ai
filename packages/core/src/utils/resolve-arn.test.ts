/**
 * Tests for resolve-arn.ts — STS-backed account ID lookup + caching +
 * timeout + the resolveResourceArn helper that wraps buildResourceArn
 * with the strict accountId guard.
 *
 * Wave 10 P1-4: this file did not exist before. The 115-line module
 * had zero unit tests despite being a high-leverage piece of code that
 * runs on every successful `assignee apply`. The Wave 10 review found
 * three latent bugs in this file (P0-2 credential fall-through,
 * P1-2 malformed-ARN truthy fallback, P1-3 STS no-timeout) that this
 * test file pins so they cannot regress.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockStsSend } = vi.hoisted(() => ({
  mockStsSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    send = mockStsSend;
  }
  function GetCallerIdentityCommand(input: unknown) {
    return { _type: "GetCallerIdentity", input };
  }
  return { STSClient, GetCallerIdentityCommand };
});

import {
  resolveResourceArn,
  getOperatorAccountId,
  getOperatorCallerArn,
  resetAccountIdCache,
} from "./resolve-arn.js";

const ORIGINAL_ENV = { ...process.env };
const REAL_ACCOUNT = "054125018476";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetAccountIdCache();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe("getOperatorAccountId", () => {
  it("returns the STS Account on first call and caches it", async () => {
    mockStsSend.mockResolvedValueOnce({
      Account: REAL_ACCOUNT,
      Arn: `arn:aws:iam::${REAL_ACCOUNT}:user/operator`,
    });

    const first = await getOperatorAccountId();
    const second = await getOperatorAccountId();

    expect(first).toBe(REAL_ACCOUNT);
    expect(second).toBe(REAL_ACCOUNT);
    // Cached: only ONE STS call for the two reads.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("de-dupes concurrent in-flight calls into a single STS request", async () => {
    let resolveSts: (value: { Account: string }) => void = () => {};
    mockStsSend.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSts = resolve;
      }),
    );

    // Fire three concurrent reads BEFORE the STS call resolves.
    const a = getOperatorAccountId();
    const b = getOperatorAccountId();
    const c = getOperatorAccountId();

    resolveSts({ Account: REAL_ACCOUNT });

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(REAL_ACCOUNT);
    expect(rb).toBe(REAL_ACCOUNT);
    expect(rc).toBe(REAL_ACCOUNT);
    // Single STS call across three concurrent callers.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  // Wave 10 P0-2: when ASSIGNEE_OPERATOR_* env vars are unset, the
  // helper used to silently fall through to the default AWS credential
  // chain via STSClient. The fix uses requireAssigneeCredentials()
  // which throws MissingAssigneeCredentialsError; the helper catches
  // that throw and returns undefined. Verify NO STS call happens.
  it("returns undefined and skips STS when operator env vars are unset", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    const result = await getOperatorAccountId();

    expect(result).toBeUndefined();
    // Critical assertion: no STS call attempted. The previous
    // (broken) code would have built an STSClient with no explicit
    // credentials and let it fall through to the default chain.
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("returns undefined when STS rejects (network failure)", async () => {
    mockStsSend.mockRejectedValueOnce(new Error("network unreachable"));

    const result = await getOperatorAccountId();

    expect(result).toBeUndefined();
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when STS rejects with AccessDenied", async () => {
    mockStsSend.mockRejectedValueOnce(
      Object.assign(new Error("access denied"), {
        name: "AccessDeniedException",
      }),
    );

    const result = await getOperatorAccountId();
    expect(result).toBeUndefined();
  });

  it("returns undefined when STS returns no Account field", async () => {
    mockStsSend.mockResolvedValueOnce({ Arn: "arn:aws:iam::role/foo" });

    const result = await getOperatorAccountId();
    expect(result).toBeUndefined();
  });

  // Wave 10 P1-3: STS regional outages used to stall the apply
  // success display indefinitely because there was no timeout. The
  // fix wraps the send() in Promise.race against a 5s timer.
  it("times out and returns undefined when STS hangs longer than 5 seconds", async () => {
    vi.useFakeTimers();
    // STS never resolves — the timeout must fire.
    mockStsSend.mockReturnValueOnce(new Promise(() => {}));

    const lookup = getOperatorAccountId();
    // Advance past the 5-second STS timeout window.
    await vi.advanceTimersByTimeAsync(5001);
    const result = await lookup;

    expect(result).toBeUndefined();
  });

  it("allows retry after a failed lookup (does not cache failure)", async () => {
    mockStsSend
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        Account: REAL_ACCOUNT,
      });

    const first = await getOperatorAccountId();
    expect(first).toBeUndefined();

    // Second call should make a fresh STS request, not return the cached failure.
    const second = await getOperatorAccountId();
    expect(second).toBe(REAL_ACCOUNT);
    expect(mockStsSend).toHaveBeenCalledTimes(2);
  });
});

describe("getOperatorCallerArn", () => {
  it("returns the full caller ARN from STS GetCallerIdentity", async () => {
    mockStsSend.mockResolvedValueOnce({
      Account: REAL_ACCOUNT,
      Arn: `arn:aws:iam::${REAL_ACCOUNT}:user/assignee-operator`,
    });

    const arn = await getOperatorCallerArn();

    expect(arn).toBe(`arn:aws:iam::${REAL_ACCOUNT}:user/assignee-operator`);
    // Only one STS call (piggybacks on getOperatorAccountId)
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when STS fails", async () => {
    mockStsSend.mockRejectedValueOnce(new Error("network failure"));

    const arn = await getOperatorCallerArn();

    expect(arn).toBeUndefined();
  });

  it("returns undefined when operator credentials are missing", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    const arn = await getOperatorCallerArn();

    expect(arn).toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("caches the ARN alongside the account ID", async () => {
    mockStsSend.mockResolvedValueOnce({
      Account: REAL_ACCOUNT,
      Arn: `arn:aws:iam::${REAL_ACCOUNT}:user/assignee-operator`,
    });

    // First call triggers the STS lookup
    const accountId = await getOperatorAccountId();
    expect(accountId).toBe(REAL_ACCOUNT);

    // Second call returns cached ARN without another STS call
    const arn = await getOperatorCallerArn();
    expect(arn).toBe(`arn:aws:iam::${REAL_ACCOUNT}:user/assignee-operator`);
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });
});

describe("resolveResourceArn", () => {
  it("returns undefined when identifier is undefined", async () => {
    const result = await resolveResourceArn({
      resourceType: "AWS::S3::Bucket",
      identifier: undefined,
    });
    expect(result).toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("short-circuits when identifier is already a full ARN", async () => {
    const result = await resolveResourceArn({
      resourceType: "AWS::S3::Bucket",
      identifier: "arn:aws:s3:::my-bucket",
    });
    expect(result).toBe("arn:aws:s3:::my-bucket");
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("builds a full ARN from a bare identifier when STS succeeds", async () => {
    mockStsSend.mockResolvedValueOnce({ Account: REAL_ACCOUNT });

    const result = await resolveResourceArn({
      resourceType: "AWS::IAM::Role",
      identifier: "my-app-role",
    });

    expect(result).toBe(`arn:aws:iam::${REAL_ACCOUNT}:role/my-app-role`);
  });

  // Wave 10 P1-2: previously this branch passed accountId="" into
  // buildResourceArn, which produced `arn:aws:iam:::role/foo` —
  // truthy AND passed isArn(), so the result-formatter's
  // `?? state.resourceArn` fallback never fired and a malformed ARN
  // propagated into provision records, billing MCP, and the
  // user-visible apply success line. Returning undefined is the
  // strict contract: NOT a malformed ARN, NOT a bare identifier,
  // NOT a half-built `arn:aws:iam:::role/...`.
  it("returns undefined (NOT a malformed ARN) when STS lookup fails", async () => {
    mockStsSend.mockRejectedValueOnce(new Error("STS unreachable"));

    const result = await resolveResourceArn({
      resourceType: "AWS::IAM::Role",
      identifier: "my-app-role",
    });

    // The undefined assertion subsumes the malformed-ARN check —
    // there is no string at all. The whole point of P1-2 is that
    // this code path no longer produces ANY string, malformed or not.
    expect(result).toBeUndefined();
  });

  it("returns undefined when operator env vars are unset (P0-2)", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    const result = await resolveResourceArn({
      resourceType: "AWS::IAM::Role",
      identifier: "my-app-role",
    });

    expect(result).toBeUndefined();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it("uses an explicit region when provided", async () => {
    mockStsSend.mockResolvedValueOnce({ Account: REAL_ACCOUNT });

    const result = await resolveResourceArn({
      resourceType: "AWS::Lambda::Function",
      identifier: "my-fn",
      region: "eu-west-2",
    });

    expect(result).toBe(
      `arn:aws:lambda:eu-west-2:${REAL_ACCOUNT}:function:my-fn`,
    );
  });
});
