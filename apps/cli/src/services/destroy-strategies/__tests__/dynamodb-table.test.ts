/**
 * Tests for dynamodb-table destroy strategy — happy-path disable,
 * propagation poll with fail-loud on missing DescribeTable permission.
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const hoisted = vi.hoisted(() => ({ mockDdbSend: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = hoisted.mockDdbSend;
  }
  function UpdateTableCommand(i: Record<string, unknown>) {
    return { _type: "UpdateTable", ...i };
  }
  function DescribeTableCommand(i: Record<string, unknown>) {
    return { _type: "DescribeTable", ...i };
  }
  return { DynamoDBClient, UpdateTableCommand, DescribeTableCommand };
});

import { dynamodbTableStrategy } from "../dynamodb-table.js";
import type { DestroyContext } from "@assignee/core";

const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error simplified stub
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

function makeCtx(): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:dynamodb:us-east-1:123456789012:table/my-table",
      resourceType: "AWS::DynamoDB::Table",
      identifier: "my-table",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
  };
}

describe("dynamodbTableStrategy", () => {
  it("calls UpdateTable to disable protection, then polls DescribeTable until visible", async () => {
    hoisted.mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "UpdateTable") return {};
      if (cmd._type === "DescribeTable") {
        return { Table: { DeletionProtectionEnabled: false } };
      }
      return {};
    });

    const outcome = await dynamodbTableStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const types = hoisted.mockDdbSend.mock.calls.map((c) => c[0]._type);
    expect(types[0]).toBe("UpdateTable");
    expect(types).toContain("DescribeTable");
  });

  it("fails loudly when operator lacks dynamodb:DescribeTable (V1 N2 invariant)", async () => {
    hoisted.mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "UpdateTable") return {};
      if (cmd._type === "DescribeTable") {
        const err = new Error(
          "User is not authorized to perform: dynamodb:DescribeTable",
        );
        (err as { name?: string }).name = "AccessDeniedException";
        throw err;
      }
      return {};
    });

    const outcome = await dynamodbTableStrategy.preDestroy!(makeCtx());
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("dynamodb:DescribeTable");
    expect(outcome?.error).toContain("missing");
  });

  it("non-permission DescribeTable errors are non-fatal (logged, continue to CCAPI)", async () => {
    hoisted.mockDdbSend.mockImplementationOnce(() => ({}));
    hoisted.mockDdbSend.mockImplementationOnce(() => {
      throw new Error("ThrottlingException");
    });

    const outcome = await dynamodbTableStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined(); // non-fatal, falls through
  });
});
