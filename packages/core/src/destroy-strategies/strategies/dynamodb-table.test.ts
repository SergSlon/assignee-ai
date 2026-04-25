/**
 * Unit tests for the DynamoDB Table destroy strategy.
 *
 * Covers:
 *   1. Happy path — deletion protection disabled, propagation confirms quickly
 *   2. Happy path — table has no deletion protection (UpdateTable succeeds, DescribeTable immediately shows false)
 *   3. Edge case — DescribeTable AccessDenied → hard failure (V1 N2 invariant)
 *   4. Edge case — DescribeTable throws transient error → warns + breaks poll
 *   5. Edge case — propagation times out (max polls reached) → warns + continues
 *   6. Edge case — MissingAssigneeCredentialsError on UpdateTable → hard failure
 *   7. Edge case — UpdateTable throws non-credential error → warns + continues
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dynamodbTableStrategy } from "./dynamodb-table.js";
import type { DestroyContext } from "../types.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockDdbSend, mockDdbDestroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockDdbSend: vi.fn(),
    mockDdbDestroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = mockDdbSend;
    destroy = mockDdbDestroy;
  }
  function UpdateTableCommand(input: unknown) {
    return { _type: "UpdateTableCommand", input };
  }
  function DescribeTableCommand(input: unknown) {
    return { _type: "DescribeTableCommand", input };
  }
  return { DynamoDBClient, UpdateTableCommand, DescribeTableCommand };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: mockRequireAssigneeCredentials,
  MissingAssigneeCredentialsError: class MissingAssigneeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MissingAssigneeCredentialsError";
    }
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const TABLE_NAME = "assignee-test-table-20260416";
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:210987654321:table/${TABLE_NAME}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: TABLE_ARN,
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      identifier: TABLE_NAME,
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    onProgress: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbDestroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  // Default: patch setTimeout to prevent real waits in tests
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Iteratively settles a polling promise under fake timers. Required because
 * `vi.runAllTimersAsync()` only sees timers queued at invocation time, but
 * the strategy's `await import()` + initial mock awaits enqueue the first
 * `setTimeout()` after several microtask hops. Loop: drain microtasks,
 * advance fake time, repeat — until the promise settles or safety cap.
 */
async function flushUntilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 200 && !settled; i++) {
    for (let j = 0; j < 5; j++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

// ── 1. Happy path — protection disabled and propagated ────────────────

describe("dynamodbTableStrategy.preDestroy — happy path", () => {
  it("disables protection and breaks poll when DescribeTable shows false", async () => {
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateTableCommand
      .mockResolvedValueOnce({
        Table: { DeletionProtectionEnabled: false },
      }); // DescribeTableCommand (immediate propagation)

    const ctx = makeCtx();
    const result = await dynamodbTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    // UpdateTable + one DescribeTable
    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 2. Happy path — no deletion protection (still protected=false from start) ──

describe("dynamodbTableStrategy.preDestroy — no protection flag", () => {
  it("breaks immediately when Table.DeletionProtectionEnabled is absent (falsy)", async () => {
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateTable
      .mockResolvedValueOnce({ Table: {} }); // Table without DeletionProtectionEnabled key

    const ctx = makeCtx();
    await dynamodbTableStrategy.preDestroy!(ctx);

    expect(mockDdbSend).toHaveBeenCalledTimes(2);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 3. DescribeTable AccessDenied → hard failure (V1 N2) ──────────────

describe("dynamodbTableStrategy.preDestroy — AccessDenied on DescribeTable", () => {
  it("returns hard failure with IAM guidance when DescribeTable is denied", async () => {
    const accessDeniedErr = Object.assign(
      new Error("not authorized to perform dynamodb:DescribeTable"),
      {
        name: "AccessDeniedException",
      },
    );
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateTable succeeds
      .mockRejectedValueOnce(accessDeniedErr); // DescribeTable denied

    const ctx = makeCtx();
    const outcome = await dynamodbTableStrategy.preDestroy!(ctx);

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("dynamodb:DescribeTable");
    expect(outcome?.error).toContain("missing");
  });
});

// ── 4. DescribeTable transient error → warns and breaks poll ──────────

describe("dynamodbTableStrategy.preDestroy — DescribeTable transient error", () => {
  it("emits dynamodb_describe_after_disable_failed and breaks poll on non-permission error", async () => {
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateTable
      .mockRejectedValueOnce(
        new Error("InternalServerError: temporary failure"),
      );

    const ctx = makeCtx();
    const result = await dynamodbTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "dynamodb_describe_after_disable_failed",
      expect.objectContaining({ identifier: TABLE_NAME, attempt: 1 }),
    );
  });
});

// ── 5. Propagation timeout ────────────────────────────────────────────

describe("dynamodbTableStrategy.preDestroy — propagation timeout", () => {
  it("warns dynamodb_disable_protection_propagation_timeout after max polls", async () => {
    // UpdateTable + 6 DescribeTable calls (all still show protected=true)
    mockDdbSend.mockResolvedValue({
      Table: { DeletionProtectionEnabled: true },
    });
    // Override UpdateTable: first call should return void, rest Describe
    mockDdbSend
      .mockResolvedValueOnce({}) // UpdateTable
      .mockResolvedValue({ Table: { DeletionProtectionEnabled: true } }); // all Describes

    const ctx = makeCtx();
    // Run all fake timers to skip the sleep
    const preDestroyPromise = dynamodbTableStrategy.preDestroy!(ctx);
    await flushUntilSettled(preDestroyPromise);
    const result = await preDestroyPromise;

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "dynamodb_disable_protection_propagation_timeout",
      expect.objectContaining({ identifier: TABLE_NAME }),
    );
  });
});

// ── 6. MissingAssigneeCredentialsError → hard failure ─────────────────

describe("dynamodbTableStrategy.preDestroy — missing credentials", () => {
  it("returns hard failure when operator credentials are absent", async () => {
    mockRequireAssigneeCredentials.mockImplementation(() => {
      throw new MissingAssigneeCredentialsError(
        "operator",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      );
    });

    const ctx = makeCtx();
    const outcome = await dynamodbTableStrategy.preDestroy!(ctx);

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain(
      "Cannot disable DynamoDB deletion protection",
    );
  });
});

// ── 7. UpdateTable non-credential error → warns, continues ────────────

describe("dynamodbTableStrategy.preDestroy — UpdateTable generic error", () => {
  it("warns dynamodb_disable_protection_failed and returns void (non-fatal)", async () => {
    mockDdbSend.mockRejectedValueOnce(
      new Error("ResourceNotFoundException: table not found"),
    );

    const ctx = makeCtx();
    const result = await dynamodbTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "dynamodb_disable_protection_failed",
      expect.objectContaining({ identifier: TABLE_NAME }),
    );
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("dynamodbTableStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(dynamodbTableStrategy.resourceType).toBe(
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
  });

  it("exposes only a preDestroy hook", () => {
    expect(typeof dynamodbTableStrategy.preDestroy).toBe("function");
    expect(dynamodbTableStrategy.destroy).toBeUndefined();
    expect(dynamodbTableStrategy.postDestroy).toBeUndefined();
  });
});
