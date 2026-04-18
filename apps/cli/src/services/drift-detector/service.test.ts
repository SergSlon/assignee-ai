/**
 * Service-level tests for DriftDetectorService — focused on the
 * retry/backoff path with deterministic jitter injection.
 *
 * The broader behavioral tests for checkResource / checkAll live in
 * `apps/cli/src/services/drift-detector.test.ts`. This file covers the
 * injectable random-source contract added to close L6-MED (Wave K1).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DriftStatus, type DriftResult } from "@assignee/core";
import {
  DRIFT_MAX_RETRIES,
  DRIFT_RETRY_BASE_DELAY_MS,
  DRIFT_RETRY_JITTER_MS,
} from "../../config/constants.js";
import { AwsErrorName } from "../../constants/aws-errors.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../provisioning-port.js";
import { DriftDetectorService } from "./service.js";

/** Construct a ProvisioningPort where getResource returns the given sequence. */
function createSequencedPort(
  results: Array<
    | { kind: "error"; message: string }
    | { kind: "ok"; props: Record<string, unknown> }
  >,
): { port: ProvisioningPort; callCount: () => number } {
  let calls = 0;
  const port: ProvisioningPort = {
    getResource: vi.fn(async () => {
      const next = results[Math.min(calls, results.length - 1)]!;
      calls++;
      if (next.kind === "error") {
        return [
          { kind: ProvisioningErrorKind.THROTTLED, message: next.message },
          null,
        ] as Awaited<ReturnType<ProvisioningPort["getResource"]>>;
      }
      return [
        null,
        {
          ResourceDescription: { Properties: JSON.stringify(next.props) },
        },
      ] as Awaited<ReturnType<ProvisioningPort["getResource"]>>;
    }),
    createResource: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
    getRequestStatus: vi.fn(),
  };
  return { port, callCount: () => calls };
}

describe("DriftDetectorService — injectable rng for retry jitter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the injected rng for retry jitter and applies exact baseDelay + rng()*JITTER delay", async () => {
    // Sanity-check the constants we depend on so the assertion is
    // grounded in the real config, not hardcoded magic numbers.
    expect(DRIFT_RETRY_JITTER_MS).toBe(100);
    expect(DRIFT_RETRY_BASE_DELAY_MS).toBe(200);
    expect(DRIFT_MAX_RETRIES).toBeGreaterThanOrEqual(1);

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // First call: throttled → triggers retry path.
    // Second call: succeeds with an IN_SYNC response.
    const { port, callCount } = createSequencedPort([
      { kind: "error", message: AwsErrorName.RATE_EXCEEDED },
      { kind: "ok", props: { BucketName: "bucket-a" } },
    ]);

    // Deterministic rng stub: every call returns 0.5 so the jitter term
    // is exactly 0.5 * DRIFT_RETRY_JITTER_MS regardless of how many
    // times the retry path consults it.
    const rng = () => 0.5;

    const service = new DriftDetectorService({
      provisioningPort: port,
      rng,
    });

    const promise = service.checkAll([
      {
        typeName: "AWS::S3::Bucket",
        identifier: "bucket-a",
        desiredState: { BucketName: "bucket-a" },
      },
    ]);

    // Drive the fake timers through the scheduled jitter delay and
    // any microtask queues the service enqueues between retries.
    await vi.runAllTimersAsync();
    const results: DriftResult[] = await promise;

    // --- Assertions on the retry delay -----------------------------------
    // attempt=0 is the initial attempt; the retry fires on attempt=0 with
    // baseDelay = DRIFT_RETRY_BASE_DELAY_MS * 2^0 = 200, and jitter = 50.
    const expectedDelay =
      DRIFT_RETRY_BASE_DELAY_MS * Math.pow(2, 0) + 0.5 * DRIFT_RETRY_JITTER_MS;

    // Filter to the retry-jitter setTimeout call (its delay matches
    // the exact value we derived). Vitest fake timers also schedule
    // internal 0-delay ticks, so we select by the delay argument.
    const jitterCalls = setTimeoutSpy.mock.calls.filter(
      (args) => args[1] === expectedDelay,
    );
    expect(jitterCalls.length).toBe(1);

    // --- Assertions on overall retry behaviour ---------------------------
    expect(callCount()).toBe(2); // throttled + successful retry
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(DriftStatus.IN_SYNC);
  });

  it("defaults rng to Math.random when not supplied (signature preserved)", () => {
    // This is a structural guarantee: omitting the new parameter must not
    // break existing call sites. We don't invoke the retry path — we just
    // verify the constructor accepts the legacy signature.
    const port: ProvisioningPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };
    expect(
      () => new DriftDetectorService({ provisioningPort: port }),
    ).not.toThrow();
  });
});
