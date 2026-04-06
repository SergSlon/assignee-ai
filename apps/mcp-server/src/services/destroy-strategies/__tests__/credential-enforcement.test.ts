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

// ── Env-var snapshot ────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── DynamoDB strategy ───────────────────────────────────────────────────────

describe("dynamodbStrategy.preDestroy", () => {
  describe("with operator credentials present", () => {
    beforeEach(() => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    });

    it("constructs the SDK client and sends UpdateTable to disable deletion protection", async () => {
      mockDdbSend.mockResolvedValueOnce({});

      await dynamodbStrategy.preDestroy!("orders-prod", "us-east-1");

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
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("throws MissingAssigneeCredentialsError and never calls the SDK", async () => {
      await expect(
        dynamodbStrategy.preDestroy!("orders-prod", "us-east-1"),
      ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
      expect(mockDdbSend).not.toHaveBeenCalled();
    });

    it("error names both required env vars", async () => {
      try {
        await dynamodbStrategy.preDestroy!("orders-prod", "us-east-1");
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
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
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

      await igwStrategy.preDestroy!("igw-0123456789abcdef0", "us-east-1");

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

      await igwStrategy.preDestroy!("igw-0123456789abcdef0", "us-east-1");

      // Only the describe — no detach for already-detached attachments
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail-closed when ASSIGNEE_OPERATOR_* missing", () => {
    beforeEach(() => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    it("throws MissingAssigneeCredentialsError and never calls the SDK", async () => {
      await expect(
        igwStrategy.preDestroy!("igw-0123456789abcdef0", "us-east-1"),
      ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
      expect(mockEc2Send).not.toHaveBeenCalled();
    });
  });
});
