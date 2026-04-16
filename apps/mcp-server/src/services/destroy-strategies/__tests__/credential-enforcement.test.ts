/**
 * Fail-closed credential enforcement tests for the per-resource-type
 * destroy strategies that construct AWS SDK clients directly
 * (DynamoDB::Table, EC2::InternetGateway).
 *
 * Both strategies must use `requireAssigneeCredentials("operator")` from
 * @assignee/core and never fall through to ~/.aws/credentials, SSO, or
 * instance metadata. When ASSIGNEE_OPERATOR_* env vars are missing the
 * strategy must throw `MissingAssigneeCredentialsError` and never call
 * the SDK send().
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MissingAssigneeCredentialsError } from "@assignee/core";

// ── Hoisted SDK mocks ───────────────────────────────────────────────────────

const { mockDdbSend, mockEc2Send } = vi.hoisted(() => ({
  mockDdbSend: vi.fn(),
  mockEc2Send: vi.fn(),
}));

// NOTE: Constructor & command mocks use plain class/function definitions
// so they survive vitest's mockReset:true (which would otherwise wipe vi.fn
// implementations between tests).
vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = mockDdbSend;
  }
  function UpdateTableCommand(input: unknown) {
    return { _type: "UpdateTable", input };
  }
  return { DynamoDBClient, UpdateTableCommand };
});

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
  }
  function DescribeInternetGatewaysCommand(input: unknown) {
    return { _type: "DescribeInternetGateways", input };
  }
  function DetachInternetGatewayCommand(input: unknown) {
    return { _type: "DetachInternetGateway", input };
  }
  return {
    EC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
  };
});

import { dynamodbStrategy } from "../dynamodb-strategy.js";
import { igwStrategy } from "../igw-strategy.js";
import { makeDestroyContext } from "./test-helpers.js";

// ── Env-var isolation ───────────────────────────────────────────────────────
// REG-N11: Use vi.stubEnv / vi.unstubAllEnvs instead of mutating process.env
// directly. The previous snapshot+restore pattern leaked AWS_* keys when a
// test threw before reaching afterEach (the snapshot was restored, but
// vi.clearAllMocks ran first and left a partial state behind). vi.stubEnv
// is auto-cleaned by `restoreMocks: true` and survives synchronous throws.

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Belt-and-suspenders: even though restoreMocks:true unstubs envs, do it
  // explicitly here so a missing config in the runner can't cause leakage.
  vi.unstubAllEnvs();
});

// ── DynamoDB strategy ───────────────────────────────────────────────────────

describe("dynamodbStrategy.preDestroy", () => {
  describe("with operator credentials present", () => {
    beforeEach(() => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv(
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
    });

    it("constructs the SDK client and sends UpdateTable to disable deletion protection", async () => {
      mockDdbSend.mockResolvedValueOnce({});

      await dynamodbStrategy.preDestroy!(
        makeDestroyContext("orders-prod", "us-east-1"),
      );

      expect(mockDdbSend).toHaveBeenCalledTimes(1);
      const cmd = mockDdbSend.mock.calls[0]![0] as {
        _type: string;
        input: { TableName: string; DeletionProtectionEnabled: boolean };
      };
      expect(cmd._type).toBe("UpdateTable");
      expect(cmd.input.TableName).toBe("orders-prod");
      expect(cmd.input.DeletionProtectionEnabled).toBe(false);
    });
  });

  describe("fail-closed when ASSIGNEE_OPERATOR_* missing", () => {
    beforeEach(() => {
      // REG-N11: stubEnv("KEY", undefined) deletes the variable, and the
      // unstub on afterEach restores the original — guaranteed even if the
      // test throws synchronously.
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", undefined as never);
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", undefined as never);
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      vi.stubEnv("AWS_ACCESS_KEY_ID", "shell-leak-key");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "shell-leak-secret");
    });

    it("throws MissingAssigneeCredentialsError and never calls the SDK", async () => {
      await expect(
        dynamodbStrategy.preDestroy!(
          makeDestroyContext("orders-prod", "us-east-1"),
        ),
      ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    it("error names both required env vars", async () => {
      try {
        await dynamodbStrategy.preDestroy!(
          makeDestroyContext("orders-prod", "us-east-1"),
        );
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
        const msg = (err as Error).message;
        expect(msg).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
        expect(msg).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
      }
    });
  });
});

// ── IGW strategy ────────────────────────────────────────────────────────────

describe("igwStrategy.preDestroy", () => {
  describe("with operator credentials present", () => {
    beforeEach(() => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
      vi.stubEnv(
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
    });

    it("describes the IGW and detaches every attached VPC", async () => {
      mockEc2Send
        .mockResolvedValueOnce({
          InternetGateways: [
            {
              InternetGatewayId: "igw-0123456789abcdef0",
              Attachments: [
                { VpcId: "vpc-0aa1bb2cc3dd4ee5f", State: "attached" },
                { VpcId: "vpc-0ff9ee8dd7cc6bb5a", State: "attached" },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      await igwStrategy.preDestroy!(
        makeDestroyContext("igw-0123456789abcdef0", "us-east-1"),
      );

      // 1 describe + 2 detaches
      expect(mockEc2Send).toHaveBeenCalledTimes(3);
      const detach1 = mockEc2Send.mock.calls[1]![0] as {
        _type: string;
        input: { InternetGatewayId: string; VpcId: string };
      };
      expect(detach1._type).toBe("DetachInternetGateway");
      expect(detach1.input.InternetGatewayId).toBe("igw-0123456789abcdef0");
      expect(detach1.input.VpcId).toBe("vpc-0aa1bb2cc3dd4ee5f");
    });

    it("skips already-detached attachments", async () => {
      mockEc2Send.mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: "igw-0123456789abcdef0",
            Attachments: [{ VpcId: "vpc-aaa", State: "detached" }],
          },
        ],
      });

      await igwStrategy.preDestroy!(
        makeDestroyContext("igw-0123456789abcdef0", "us-east-1"),
      );

      // Only the describe — no detach for already-detached attachments
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail-closed when ASSIGNEE_OPERATOR_* missing", () => {
    beforeEach(() => {
      vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", undefined as never);
      vi.stubEnv("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY", undefined as never);
      vi.stubEnv("AWS_ACCESS_KEY_ID", "shell-leak-key");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "shell-leak-secret");
    });

    it("throws MissingAssigneeCredentialsError and never calls the SDK", async () => {
      await expect(
        igwStrategy.preDestroy!(
          makeDestroyContext("igw-0123456789abcdef0", "us-east-1"),
        ),
      ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });
  });
});

// REG-N11 regression: an env var stubbed in one test must NOT survive into
// the next test, even if the previous test threw or did weird things to
// process.env. We rely on `vi.unstubAllEnvs()` in afterEach.
describe("REG-N11: env-var leakage between tests", () => {
  it("stubbed AWS_ACCESS_KEY_ID is restored before this test runs", () => {
    // Either it's truly undefined OR it's whatever the host runtime had
    // BEFORE the suite started — what we must NOT see is the leaked value
    // "shell-leak-key" from the fail-closed beforeEach blocks above.
    expect(process.env["AWS_ACCESS_KEY_ID"]).not.toBe("shell-leak-key");
    expect(process.env["AWS_SECRET_ACCESS_KEY"]).not.toBe("shell-leak-secret");
  });

  it("stubEnv with a real value is unstubbed by afterEach (sanity check)", () => {
    vi.stubEnv("ASSIGNEE_OPERATOR_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(
      "AKIAIOSFODNN7EXAMPLE",
    );
    // Manual unstub to prove the mechanism works mid-test.
    vi.unstubAllEnvs();
    // After unstub, the value is restored to whatever it was at suite start.
    expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).not.toBe(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });
});
