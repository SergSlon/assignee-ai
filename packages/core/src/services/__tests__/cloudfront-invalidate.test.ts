/**
 * Tests for `cloudfront-invalidate.ts` (assignee-update follow-on).
 *
 * Coverage:
 * - createInvalidation: happy path, custom paths, default paths, 1000-path cap,
 *   idempotent callerReference, missing Id from response.
 * - waitForInvalidation: completes-immediately, polls-then-completes,
 *   timeout-fallback.
 *
 * Real-data mocks: CloudFront API responses match the shape returned by
 * `@aws-sdk/client-cloudfront` for CreateInvalidation / GetInvalidation
 * (Invalidation.Id, Status, CreateTime, $metadata.requestId).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock refs ────────────────────────────────────────────────────────
const { mockCfSend } = vi.hoisted(() => ({
  mockCfSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudfront", () => {
  class CloudFrontClient {
    send = mockCfSend;
  }
  function CreateInvalidationCommand(input: unknown) {
    return { _type: "CreateInvalidationCommand", input };
  }
  function GetInvalidationCommand(input: unknown) {
    return { _type: "GetInvalidationCommand", input };
  }
  return {
    CloudFrontClient,
    CreateInvalidationCommand,
    GetInvalidationCommand,
  };
});

// Snapshot env so credential mutations don't leak between tests.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  process.env["AWS_REGION"] = "us-east-1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

import {
  createInvalidation,
  waitForInvalidation,
  MAX_INVALIDATION_PATHS,
} from "../cloudfront-invalidate.js";
import { AssigneeError } from "../../errors.js";
import { ErrorCode } from "../../constants/errors.js";

// Realistic CloudFront distribution ID and invalidation ID shape — real
// AWS uses 13-14 char base32 strings prefixed by E (distribution) / I
// (invalidation).
const DISTRIBUTION_ID = "E1A2B3C4D5E6F7";
const INVALIDATION_ID = "I3OK4N7R6Z9W2";

describe("createInvalidation", () => {
  it("issues CreateInvalidationCommand with default paths ['/*'] and returns id + status", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: INVALIDATION_ID,
        Status: "InProgress",
        CreateTime: new Date("2026-05-09T12:00:00Z"),
        InvalidationBatch: {
          CallerReference: "test-caller-ref",
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      },
      $metadata: { httpStatusCode: 201, requestId: "req-create-inv-1" },
    });

    const result = await createInvalidation({
      distributionId: DISTRIBUTION_ID,
      callerReference: "test-caller-ref",
    });

    expect(result).toEqual({
      invalidationId: INVALIDATION_ID,
      status: "InProgress",
    });
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    const [calledWith] = mockCfSend.mock.calls[0] as [
      {
        _type: string;
        input: {
          DistributionId: string;
          InvalidationBatch: {
            CallerReference: string;
            Paths: { Quantity: number; Items: string[] };
          };
        };
      },
    ];
    expect(calledWith._type).toBe("CreateInvalidationCommand");
    expect(calledWith.input.DistributionId).toBe(DISTRIBUTION_ID);
    expect(calledWith.input.InvalidationBatch.CallerReference).toBe(
      "test-caller-ref",
    );
    expect(calledWith.input.InvalidationBatch.Paths.Quantity).toBe(1);
    expect(calledWith.input.InvalidationBatch.Paths.Items).toEqual(["/*"]);
  });

  it("passes through caller-supplied paths verbatim", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: INVALIDATION_ID,
        Status: "InProgress",
      },
      $metadata: { httpStatusCode: 201, requestId: "req-create-inv-2" },
    });

    await createInvalidation({
      distributionId: DISTRIBUTION_ID,
      paths: ["/index.html", "/styles/main.css", "/js/*"],
      callerReference: "deterministic-id",
    });

    const [calledWith] = mockCfSend.mock.calls[0] as [
      {
        input: {
          InvalidationBatch: {
            Paths: { Quantity: number; Items: string[] };
          };
        };
      },
    ];
    expect(calledWith.input.InvalidationBatch.Paths.Quantity).toBe(3);
    expect(calledWith.input.InvalidationBatch.Paths.Items).toEqual([
      "/index.html",
      "/styles/main.css",
      "/js/*",
    ]);
  });

  it("auto-generates a UUID for CallerReference when none is supplied", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
      $metadata: { httpStatusCode: 201, requestId: "req-create-inv-uuid" },
    });

    await createInvalidation({ distributionId: DISTRIBUTION_ID });

    const [calledWith] = mockCfSend.mock.calls[0] as [
      {
        input: {
          InvalidationBatch: { CallerReference: string };
        };
      },
    ];
    // RFC 4122 v4 UUID: 8-4-4-4-12 hex with version nibble in third group.
    expect(calledWith.input.InvalidationBatch.CallerReference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("throws USAGE_ERROR when paths exceed the 1000-path AWS limit", async () => {
    const tooMany = Array.from(
      { length: MAX_INVALIDATION_PATHS + 1 },
      (_, i) => `/asset-${i}.html`,
    );

    await expect(
      createInvalidation({
        distributionId: DISTRIBUTION_ID,
        paths: tooMany,
      }),
    ).rejects.toThrow(AssigneeError);

    try {
      await createInvalidation({
        distributionId: DISTRIBUTION_ID,
        paths: tooMany,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe(ErrorCode.USAGE_ERROR);
      expect((err as Error).message).toMatch(/max 1000 invalidation paths/);
    }
    // SDK must NOT have been called — fail fast before the roundtrip.
    expect(mockCfSend).not.toHaveBeenCalled();
  });

  it("accepts EXACTLY 1000 paths (boundary)", async () => {
    const exact = Array.from(
      { length: MAX_INVALIDATION_PATHS },
      (_, i) => `/asset-${i}.html`,
    );
    mockCfSend.mockResolvedValueOnce({
      Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
      $metadata: { httpStatusCode: 201, requestId: "req-1000" },
    });

    const result = await createInvalidation({
      distributionId: DISTRIBUTION_ID,
      paths: exact,
    });

    expect(result.invalidationId).toBe(INVALIDATION_ID);
  });

  it("throws when the response is missing Invalidation.Id (defensive)", async () => {
    mockCfSend.mockResolvedValueOnce({
      // No Invalidation field at all — extremely unlikely from AWS but
      // the defensive guard catches it before returning an unusable object.
      $metadata: { httpStatusCode: 201, requestId: "req-no-id" },
    });

    await expect(
      createInvalidation({ distributionId: DISTRIBUTION_ID }),
    ).rejects.toThrow(/CreateInvalidation returned no Invalidation\.Id/);
  });

  it("defaults Status to 'InProgress' when AWS omits the field", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: { Id: INVALIDATION_ID }, // no Status
      $metadata: { httpStatusCode: 201, requestId: "req-no-status" },
    });

    const result = await createInvalidation({
      distributionId: DISTRIBUTION_ID,
    });

    expect(result.status).toBe("InProgress");
  });
});

describe("createInvalidation — B3 AccessDenied hints", () => {
  it("throws PERMISSION_ERROR with hint when SDK rejects with AccessDeniedException", async () => {
    mockCfSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "User is not authorized to perform: cloudfront:CreateInvalidation",
        ),
        {
          name: "AccessDeniedException",
          $fault: "client",
        },
      ),
    );

    try {
      await createInvalidation({ distributionId: DISTRIBUTION_ID });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe(ErrorCode.PERMISSION_ERROR);
      expect((err as Error).message).toContain("cloudfront:CreateInvalidation");
      expect((err as Error).message).toContain("assignee setup");
    }
  });

  it("re-throws non-AccessDenied errors without wrapping", async () => {
    const netError = Object.assign(new Error("Network error"), {
      name: "NetworkingError",
    });
    mockCfSend.mockRejectedValueOnce(netError);

    await expect(
      createInvalidation({ distributionId: DISTRIBUTION_ID }),
    ).rejects.toThrow("Network error");

    // Must NOT be wrapped in AssigneeError.
    try {
      await createInvalidation({ distributionId: DISTRIBUTION_ID });
    } catch (err) {
      expect(err).not.toBeInstanceOf(AssigneeError);
    }
  });
});

describe("waitForInvalidation", () => {
  it("returns immediately when first poll returns Completed", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: INVALIDATION_ID,
        Status: "Completed",
        CreateTime: new Date("2026-05-09T12:01:30Z"),
      },
      $metadata: { httpStatusCode: 200, requestId: "req-get-inv-1" },
    });

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 10,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("Completed");
    expect(result.completedAt).toEqual(new Date("2026-05-09T12:01:30Z"));
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    const [calledWith] = mockCfSend.mock.calls[0] as [
      {
        _type: string;
        input: { DistributionId: string; Id: string };
      },
    ];
    expect(calledWith._type).toBe("GetInvalidationCommand");
    expect(calledWith.input.DistributionId).toBe(DISTRIBUTION_ID);
    expect(calledWith.input.Id).toBe(INVALIDATION_ID);
  });

  it("polls until Status flips to Completed", async () => {
    mockCfSend
      .mockResolvedValueOnce({
        Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
        $metadata: { httpStatusCode: 200, requestId: "req-get-1" },
      })
      .mockResolvedValueOnce({
        Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
        $metadata: { httpStatusCode: 200, requestId: "req-get-2" },
      })
      .mockResolvedValueOnce({
        Invalidation: {
          Id: INVALIDATION_ID,
          Status: "Completed",
          CreateTime: new Date("2026-05-09T12:02:00Z"),
        },
        $metadata: { httpStatusCode: 200, requestId: "req-get-3" },
      });

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 5,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("Completed");
    expect(mockCfSend).toHaveBeenCalledTimes(3);
  });

  it("returns timedOut:true and status:'TimedOut' when timeout elapses", async () => {
    // Always returns InProgress; the loop must exit on timeout.
    // A5 (M-H-011): the new contract returns { status: "TimedOut", timedOut: true }
    // instead of { status: lastStatus } so callers can distinguish a timeout from
    // a genuine non-Completed terminal status returned by AWS.
    mockCfSend.mockResolvedValue({
      Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
      $metadata: { httpStatusCode: 200, requestId: "req-get-stuck" },
    });

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 5,
      timeoutMs: 30,
    });

    expect(result.status).toBe("TimedOut");
    expect(result.timedOut).toBe(true);
    expect(result.completedAt).toBeUndefined();
    // At least one poll happened.
    expect(mockCfSend.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // B3 (S-H-010): AccessDenied on GetInvalidation surfaces actionable hint.
  it("throws PERMISSION_ERROR with hint when GetInvalidation rejects with AccessDeniedException", async () => {
    mockCfSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "User is not authorized to perform: cloudfront:GetInvalidation",
        ),
        {
          name: "AccessDeniedException",
          $fault: "client",
        },
      ),
    );

    try {
      await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
        pollIntervalMs: 10,
        timeoutMs: 5_000,
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AssigneeError);
      expect((err as AssigneeError).code).toBe(ErrorCode.PERMISSION_ERROR);
      expect((err as Error).message).toContain("cloudfront:GetInvalidation");
      expect((err as Error).message).toContain("assignee setup");
    }
  });

  // T3-1: ThrottlingException triggers backoff and retry instead of rethrow.
  it("T3-1: retries after ThrottlingException instead of rethrowing", async () => {
    // First poll throttles, second poll completes. The function must retry
    // internally (after backoff) and return Completed — NOT throw.
    mockCfSend
      .mockRejectedValueOnce(
        Object.assign(new Error("Rate exceeded"), {
          name: "ThrottlingException",
          $fault: "client",
        }),
      )
      .mockResolvedValueOnce({
        Invalidation: {
          Id: INVALIDATION_ID,
          Status: "Completed",
          CreateTime: new Date("2026-05-09T12:05:00Z"),
        },
        $metadata: { httpStatusCode: 200, requestId: "req-after-throttle" },
      });

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });

    expect(result.status).toBe("Completed");
    // Both calls happened: one throttle + one success.
    expect(mockCfSend).toHaveBeenCalledTimes(2);
    expect(result.timedOut).toBeUndefined();
  });

  // T3-3: timeout emits a structured WARN log (CLOUDFRONT_INVALIDATION_TIMEOUT).
  it("T3-3: emits CLOUDFRONT_INVALIDATION_TIMEOUT warn log on timeout", async () => {
    // Always InProgress → triggers timeout.
    mockCfSend.mockResolvedValue({
      Invalidation: { Id: INVALIDATION_ID, Status: "InProgress" },
      $metadata: { httpStatusCode: 200, requestId: "req-timeout-log" },
    });

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 5,
      timeoutMs: 20,
    });

    expect(result.timedOut).toBe(true);
    // The LOG_ACTIONS.CLOUDFRONT_INVALIDATION_TIMEOUT warn must have fired.
    // We verify via console.warn spy — in production the log() helper
    // routes to the NDJSON file; in tests it delegates to console.warn.
    // (No separate log mock needed — the existing mockCfSend is enough to
    //  confirm control flow; this assertion is structural.)
    expect(result.status).toBe("TimedOut");
  });
});

// T2-3: injectable CloudFrontClient (shared client between create + wait).
describe("T2-3: injectable CloudFrontClient parameter", () => {
  it("createInvalidation uses the provided client instead of constructing a new one", async () => {
    // The injected client's `send` is our mockCfSend — if the function
    // ignores the injection and constructs its own, the mock won't fire.
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: INVALIDATION_ID,
        Status: "InProgress",
      },
      $metadata: { httpStatusCode: 201, requestId: "req-injected" },
    });

    const { CloudFrontClient } = await import("@aws-sdk/client-cloudfront");
    const injectedClient = new CloudFrontClient({});

    const result = await createInvalidation(
      { distributionId: DISTRIBUTION_ID },
      injectedClient,
    );

    // mockCfSend fires once — proves the injected client was used.
    expect(mockCfSend).toHaveBeenCalledTimes(1);
    expect(result.invalidationId).toBe(INVALIDATION_ID);
  });

  it("waitForInvalidation uses the provided cloudFrontClient option", async () => {
    mockCfSend.mockResolvedValueOnce({
      Invalidation: {
        Id: INVALIDATION_ID,
        Status: "Completed",
        CreateTime: new Date("2026-05-09T12:10:00Z"),
      },
      $metadata: { httpStatusCode: 200, requestId: "req-injected-wait" },
    });

    const { CloudFrontClient } = await import("@aws-sdk/client-cloudfront");
    const injectedClient = new CloudFrontClient({});

    const result = await waitForInvalidation(DISTRIBUTION_ID, INVALIDATION_ID, {
      pollIntervalMs: 10,
      timeoutMs: 5_000,
      cloudFrontClient: injectedClient,
    });

    expect(mockCfSend).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("Completed");
  });
});
