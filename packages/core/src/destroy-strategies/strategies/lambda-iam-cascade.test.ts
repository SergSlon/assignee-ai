/**
 * BUG-10 — Lambda IAM exec role cascade destroy.
 *
 * Verifies that destroying a Lambda function auto-destroys the companion
 * IAM execution role created by the `lambda-with-exec-role` compound
 * pattern, and that user-provided roles (non-assignee-prefixed) are never
 * touched.
 *
 * Covers:
 *   1. Happy path: Lambda ARN found in provision log → companion IAM role
 *      deleted via CCAPI DELETE + poll → SUCCESS.
 *   2. No companion role (Lambda created standalone or role already gone):
 *      no CCAPI call, no error.
 *   3. User-provided role (ARN does NOT match assignee-iam-execution-role-
 *      prefix): skipped entirely — never deleted.
 *   4. CCAPI delete returns FAILED status: non-fatal, warnDestroy called,
 *      postDestroy resolves without throwing.
 *   5. CCAPI delete returns NotFound status: treated as already-gone,
 *      resolves cleanly.
 *   6. Provision log throws: non-fatal, warnDestroy called, resolves.
 *   7. Lambda ARN not in provision log (orphan Lambda): no CCAPI call.
 *   8. Two Lambda functions share different runIds — only the correct
 *      companion role is cascaded.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import { lambdaFunctionStrategy } from "./lambda-function.js";
import type { DestroyContext } from "../types.js";

// ── Hoist mock handles before vi.mock calls ───────────────────────────
const { mockCCSend } = vi.hoisted(() => ({ mockCCSend: vi.fn() }));
const { mockListProvisionRecords } = vi.hoisted(() => ({
  mockListProvisionRecords: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class CloudControlClient {
    send = mockCCSend;
    destroy = vi.fn();
  }
  function DeleteResourceCommand(input: unknown) {
    return { _type: "DeleteResourceCommand", input };
  }
  function GetResourceRequestStatusCommand(input: unknown) {
    return { _type: "GetResourceRequestStatusCommand", input };
  }
  return {
    CloudControlClient,
    DeleteResourceCommand,
    GetResourceRequestStatusCommand,
  };
});

vi.mock("../../managed-resources/store.js", () => ({
  listProvisionRecords: mockListProvisionRecords,
}));

// ── Shared test fixtures ──────────────────────────────────────────────

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RUN_ID_SHORT = "aaaaaaaa"; // first 8 chars of RUN_ID

const LAMBDA_ARN =
  "arn:aws:lambda:us-east-1:210987654321:function:assignee-lambda-fn-aaaaaaaa";
const ROLE_ARN = `arn:aws:iam::210987654321:role/assignee-iam-execution-role-${RUN_ID_SHORT}`;
const ROLE_NAME = `assignee-iam-execution-role-${RUN_ID_SHORT}`;

/** Minimal provision record shape matching StoredProvisionRecord. */
function lambdaRecord(runId = RUN_ID) {
  return {
    keyKind: "arn" as const,
    key: LAMBDA_ARN,
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    region: "us-east-1",
    createdDate: "2026-04-23T00:00:00.000Z",
    estimatedMonthlyCost: "$0.01/mo",
    runId,
  };
}

function roleRecord(runId = RUN_ID, roleArn = ROLE_ARN) {
  return {
    keyKind: "arn" as const,
    key: roleArn,
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    region: "us-east-1",
    createdDate: "2026-04-23T00:00:00.000Z",
    estimatedMonthlyCost: "$0.00/mo",
    runId,
  };
}

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: LAMBDA_ARN,
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      identifier: "assignee-lambda-fn-aaaaaaaa",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIATEST",
      secretAccessKey: "secrettest",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    onProgress: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

// ── Test setup ────────────────────────────────────────────────────────

beforeEach(() => {
  mockCCSend.mockReset();
  mockListProvisionRecords.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. Happy path ─────────────────────────────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — happy path", () => {
  it("cascades to companion IAM role and deletes it on SUCCESS poll", async () => {
    mockListProvisionRecords.mockResolvedValue([lambdaRecord(), roleRecord()]);

    // First send: DeleteResourceCommand → returns request token.
    // Second send: GetResourceRequestStatusCommand → SUCCESS.
    mockCCSend
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "token-abc" },
      })
      .mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
      });

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    // CCAPI was called twice: delete + one status poll.
    expect(mockCCSend).toHaveBeenCalledTimes(2);

    // First call must be DeleteResourceCommand for the role name.
    const deleteCall = (mockCCSend as Mock).mock.calls[0];
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toMatchObject({
      _type: "DeleteResourceCommand",
      input: {
        TypeName: RESOURCE_TYPES.IAM_ROLE,
        Identifier: ROLE_NAME,
      },
    });

    // Progress message emitted.
    expect(ctx.onProgress).toHaveBeenCalledWith(
      expect.stringContaining(ROLE_NAME),
    );
  });
});

// ── 2. No companion role ──────────────────────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — no companion role", () => {
  it("does nothing when no IAM role shares the Lambda runId", async () => {
    mockListProvisionRecords.mockResolvedValue([lambdaRecord()]);

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    expect(mockCCSend).not.toHaveBeenCalled();
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("does nothing when Lambda ARN is not in the provision log", async () => {
    // Return records for a different Lambda (different ARN).
    mockListProvisionRecords.mockResolvedValue([
      {
        ...lambdaRecord(),
        key: "arn:aws:lambda:us-east-1:210987654321:function:other-fn",
      },
      roleRecord(),
    ]);

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    expect(mockCCSend).not.toHaveBeenCalled();
  });
});

// ── 3. User-provided role guard ───────────────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — user-provided role skip", () => {
  it("does NOT cascade to a user-provided role (non-assignee prefix)", async () => {
    const userRoleArn =
      "arn:aws:iam::210987654321:role/my-custom-execution-role";
    mockListProvisionRecords.mockResolvedValue([
      lambdaRecord(),
      roleRecord(RUN_ID, userRoleArn),
    ]);

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    expect(mockCCSend).not.toHaveBeenCalled();
    expect(ctx.warn).not.toHaveBeenCalled();
  });

  it("does NOT cascade when role name contains assignee-iam-execution-role as a substring but has different prefix", async () => {
    const trickyRoleArn =
      "arn:aws:iam::210987654321:role/prod-assignee-iam-execution-role-12345678";
    mockListProvisionRecords.mockResolvedValue([
      lambdaRecord(),
      roleRecord(RUN_ID, trickyRoleArn),
    ]);

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    expect(mockCCSend).not.toHaveBeenCalled();
  });
});

// ── 4. CCAPI delete FAILED (non-fatal) ───────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — CCAPI failure is non-fatal", () => {
  it("logs a warn but resolves when CCAPI returns FAILED status", async () => {
    mockListProvisionRecords.mockResolvedValue([lambdaRecord(), roleRecord()]);

    mockCCSend
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "token-xyz" },
      })
      .mockResolvedValueOnce({
        ProgressEvent: {
          OperationStatus: "FAILED",
          ErrorCode: "InternalFailure",
          StatusMessage: "AWS internal error",
        },
      });

    const ctx = makeCtx();
    await expect(
      lambdaFunctionStrategy.postDestroy!(ctx),
    ).resolves.not.toThrow();

    expect(ctx.warn).toHaveBeenCalledWith(
      "lambda_cascade_role_delete_failed",
      expect.objectContaining({ roleName: ROLE_NAME }),
    );
  });

  it("resolves cleanly and does not call warn when CCAPI throws", async () => {
    mockListProvisionRecords.mockResolvedValue([lambdaRecord(), roleRecord()]);

    mockCCSend.mockRejectedValueOnce(new Error("Network timeout"));

    const ctx = makeCtx();
    await expect(
      lambdaFunctionStrategy.postDestroy!(ctx),
    ).resolves.not.toThrow();

    expect(ctx.warn).toHaveBeenCalledWith(
      "lambda_cascade_role_delete_error",
      expect.objectContaining({ roleName: ROLE_NAME }),
    );
  });
});

// ── 5. NotFound status → already gone ────────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — NotFound treated as success", () => {
  it("resolves cleanly when role is already gone (NotFound poll)", async () => {
    mockListProvisionRecords.mockResolvedValue([lambdaRecord(), roleRecord()]);

    mockCCSend
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "token-nf" },
      })
      .mockResolvedValueOnce({
        ProgressEvent: {
          OperationStatus: "FAILED",
          ErrorCode: "NotFound",
        },
      });

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    // NotFound → success, no warn.
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 6. Provision log throws ───────────────────────────────────────────

describe("lambdaFunctionStrategy.postDestroy — provision log error is non-fatal", () => {
  it("logs warn and resolves when listProvisionRecords throws", async () => {
    mockListProvisionRecords.mockRejectedValueOnce(
      new Error("provisions.json corrupted"),
    );

    const ctx = makeCtx();
    await expect(
      lambdaFunctionStrategy.postDestroy!(ctx),
    ).resolves.not.toThrow();

    expect(mockCCSend).not.toHaveBeenCalled();
    expect(ctx.warn).toHaveBeenCalledWith(
      "lambda_cascade_provision_lookup_failed",
      expect.objectContaining({ identifier: ctx.resource.identifier }),
    );
  });
});

// ── 7. Correct companion selected when multiple runIds present ────────

describe("lambdaFunctionStrategy.postDestroy — runId isolation", () => {
  it("only deletes the companion role that shares the Lambda's runId", async () => {
    const OTHER_RUN_ID = "11111111-2222-3333-4444-555555555555";
    const OTHER_ROLE_ARN =
      "arn:aws:iam::210987654321:role/assignee-iam-execution-role-11111111";

    mockListProvisionRecords.mockResolvedValue([
      lambdaRecord(RUN_ID),
      roleRecord(RUN_ID, ROLE_ARN),
      // A second, unrelated Lambda+Role pair from a different run.
      {
        keyKind: "arn" as const,
        key: "arn:aws:lambda:us-east-1:210987654321:function:assignee-lambda-fn-11111111",
        resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
        region: "us-east-1",
        createdDate: "2026-04-23T00:00:00.000Z",
        estimatedMonthlyCost: "$0.01/mo",
        runId: OTHER_RUN_ID,
      },
      roleRecord(OTHER_RUN_ID, OTHER_ROLE_ARN),
    ]);

    mockCCSend
      .mockResolvedValueOnce({ ProgressEvent: { RequestToken: "tok" } })
      .mockResolvedValueOnce({ ProgressEvent: { OperationStatus: "SUCCESS" } });

    const ctx = makeCtx();
    await lambdaFunctionStrategy.postDestroy!(ctx);

    // Only ONE delete call, for the correct role.
    const deleteCall = (mockCCSend as Mock).mock.calls[0];
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0].input.Identifier).toBe(ROLE_NAME);
    expect(deleteCall![0].input.Identifier).not.toContain("11111111");
  });
});

// ── 8. Strategy is registered for LAMBDA_FUNCTION type ───────────────

describe("lambdaFunctionStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(lambdaFunctionStrategy.resourceType).toBe(
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
  });

  it("exposes a postDestroy hook", () => {
    expect(typeof lambdaFunctionStrategy.postDestroy).toBe("function");
  });
});
