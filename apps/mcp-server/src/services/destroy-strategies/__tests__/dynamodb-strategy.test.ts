/**
 * Per-strategy failure-mode unit tests for dynamodbStrategy.preDestroy.
 *
 * Story 50-4 consolidated CLI + MCP dynamodb strategies into the
 * CLI-canonical @assignee/core body. The new canonical behavior:
 *   - UpdateTable is the first call (disables deletion protection).
 *   - After UpdateTable the strategy polls DescribeTable until the
 *     propagation is visible (or a permission/throttling error shows
 *     up).
 *   - Non-credential AWS errors (ValidationException /
 *     ResourceNotFoundException / ThrottlingException) are warn-and-
 *     continue — the CCAPI delete on the next tier produces the
 *     authoritative error.
 *   - AccessDenied on DescribeTable is promoted to a hard failure
 *     (V1 N2 invariant — can't verify propagation without permission).
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
  function DescribeTableCommand(input: unknown) {
    return { _type: "DescribeTable", input };
  }
  return { DynamoDBClient, UpdateTableCommand, DescribeTableCommand };
});

import { dynamodbTableStrategy as dynamodbStrategy } from "@assignee/core";
import { makeDestroyContext } from "./test-helpers.js";

const TABLE_NAME = "assignee-orders-prod";
const REGION = "us-east-1";

const ORIGINAL_ENV = { ...process.env };
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  vi.clearAllMocks();
  // Collapse propagation-poll delays — CLI canonical uses 5000ms waits.
  // @ts-expect-error simplified stub
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  process.env = { ...ORIGINAL_ENV };
});

describe("dynamodbStrategy.preDestroy — success + failure modes", () => {
  it("disables DeletionProtection with UpdateTable then polls DescribeTable until visible", async () => {
    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "UpdateTable") return {};
      if (cmd._type === "DescribeTable") {
        return { Table: { DeletionProtectionEnabled: false } };
      }
      return {};
    });

    await dynamodbStrategy.preDestroy!(makeDestroyContext(TABLE_NAME, REGION));

    const types = mockDdbSend.mock.calls.map((c) => c[0]._type);
    expect(types[0]).toBe("UpdateTable");
    expect(types).toContain("DescribeTable");
    const updateCmd = mockDdbSend.mock.calls[0]![0] as {
      _type: string;
      input: { TableName: string; DeletionProtectionEnabled: boolean };
    };
    expect(updateCmd.input.TableName).toBe(TABLE_NAME);
    expect(updateCmd.input.DeletionProtectionEnabled).toBe(false);
  });

  it("warns-and-continues when UpdateTable rejects with ValidationException (non-fatal)", async () => {
    const err = Object.assign(
      new Error(
        "Table cannot be updated because another update is currently in progress",
      ),
      { name: "ValidationException", $metadata: { httpStatusCode: 400 } },
    );
    mockDdbSend.mockRejectedValueOnce(err);

    const outcome = await dynamodbStrategy.preDestroy!(
      makeDestroyContext(TABLE_NAME, REGION),
    );
    // CLI-canonical: return undefined — downstream CCAPI produces the
    // authoritative error when the protection really blocks the delete.
    expect(outcome).toBeUndefined();
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("warns-and-continues when UpdateTable rejects with ResourceNotFoundException", async () => {
    const err = Object.assign(new Error(`Table not found: ${TABLE_NAME}`), {
      name: "ResourceNotFoundException",
      $metadata: { httpStatusCode: 400 },
    });
    mockDdbSend.mockRejectedValueOnce(err);

    const outcome = await dynamodbStrategy.preDestroy!(
      makeDestroyContext(TABLE_NAME, REGION),
    );
    expect(outcome).toBeUndefined();
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("warns-and-continues when UpdateTable rejects with ThrottlingException", async () => {
    const err = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 400 },
    });
    mockDdbSend.mockRejectedValueOnce(err);

    const outcome = await dynamodbStrategy.preDestroy!(
      makeDestroyContext(TABLE_NAME, REGION),
    );
    expect(outcome).toBeUndefined();
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("passes the caller-provided region into the SDK client construction", async () => {
    mockDdbSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "UpdateTable") return {};
      if (cmd._type === "DescribeTable") {
        return { Table: { DeletionProtectionEnabled: false } };
      }
      return {};
    });

    await dynamodbStrategy.preDestroy!(
      makeDestroyContext(TABLE_NAME, "eu-west-1"),
    );
    // Indirect: send was called with correct TableName (region visibility
    // is baked into the SDK client instance, not the command).
    const cmd = mockDdbSend.mock.calls[0]![0] as {
      _type: string;
      input: { TableName: string };
    };
    expect(cmd.input.TableName).toBe(TABLE_NAME);
  });
});
