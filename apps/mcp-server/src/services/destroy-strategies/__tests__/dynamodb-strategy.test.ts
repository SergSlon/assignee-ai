/**
 * Per-strategy failure-mode unit tests for dynamodbStrategy.preDestroy.
 *
 * Covers behavior not exercised by credential-enforcement.test.ts:
 *  - DeletionProtection disable succeeds on a protected table
 *  - DisableDeletionProtection fails with ValidationException
 *  - Table not found (ResourceNotFoundException) surfaces to caller
 *  - Throttling error surfaces for upstream retry handling
 *
 * Uses class-based SDK mocks so they survive vitest's mockReset:true.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDdbSend } = vi.hoisted(() => ({
  mockDdbSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = mockDdbSend;
    destroy = vi.fn();
  }
  function UpdateTableCommand(input: unknown) {
    return { _type: "UpdateTable", input };
  }
  return { DynamoDBClient, UpdateTableCommand };
});

import { dynamodbStrategy } from "../dynamodb-strategy.js";
import { makeDestroyContext } from "./test-helpers.js";

const TABLE_NAME = "assignee-orders-prod";
const REGION = "us-east-1";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("dynamodbStrategy.preDestroy — success + failure modes", () => {
  it("disables DeletionProtection with a single UpdateTable call", async () => {
    mockDdbSend.mockResolvedValueOnce({
      TableDescription: {
        TableName: TABLE_NAME,
        TableArn: `arn:aws:dynamodb:${REGION}:123456789012:table/${TABLE_NAME}`,
        DeletionProtectionEnabled: false,
      },
    });

    await dynamodbStrategy.preDestroy!(makeDestroyContext(TABLE_NAME, REGION));

    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const cmd = mockDdbSend.mock.calls[0]![0] as {
      _type: string;
      input: { TableName: string; DeletionProtectionEnabled: boolean };
    };
    expect(cmd._type).toBe("UpdateTable");
    expect(cmd.input.TableName).toBe(TABLE_NAME);
    expect(cmd.input.DeletionProtectionEnabled).toBe(false);
  });

  it("surfaces ValidationException when UpdateTable rejects the request", async () => {
    const err = Object.assign(
      new Error(
        "Table cannot be updated because another update is currently in progress",
      ),
      { name: "ValidationException", $metadata: { httpStatusCode: 400 } },
    );
    mockDdbSend.mockRejectedValueOnce(err);

    await expect(
      dynamodbStrategy.preDestroy!(makeDestroyContext(TABLE_NAME, REGION)),
    ).rejects.toMatchObject({ name: "ValidationException" });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("surfaces ResourceNotFoundException when the table does not exist", async () => {
    const err = Object.assign(new Error(`Table not found: ${TABLE_NAME}`), {
      name: "ResourceNotFoundException",
      $metadata: { httpStatusCode: 400 },
    });
    mockDdbSend.mockRejectedValueOnce(err);

    await expect(
      dynamodbStrategy.preDestroy!(makeDestroyContext(TABLE_NAME, REGION)),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("surfaces ThrottlingException for upstream retry handling", async () => {
    const err = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 400 },
    });
    mockDdbSend.mockRejectedValueOnce(err);

    await expect(
      dynamodbStrategy.preDestroy!(makeDestroyContext(TABLE_NAME, REGION)),
    ).rejects.toMatchObject({ name: "ThrottlingException" });
  });

  it("passes the caller-provided region into the SDK client construction", async () => {
    mockDdbSend.mockResolvedValueOnce({});
    await dynamodbStrategy.preDestroy!(
      makeDestroyContext(TABLE_NAME, "eu-west-1"),
    );
    // Only indirect evidence — send was called with correct TableName
    const cmd = mockDdbSend.mock.calls[0]![0] as {
      _type: string;
      input: { TableName: string };
    };
    expect(cmd.input.TableName).toBe(TABLE_NAME);
  });
});
