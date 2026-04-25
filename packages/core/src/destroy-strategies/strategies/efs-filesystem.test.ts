/**
 * Unit tests for the EFS FileSystem destroy strategy.
 *
 * Covers:
 *   1. Happy path — no mount targets; preDestroy is a no-op
 *   2. Happy path — one mount target deleted, poll confirms zero remaining
 *   3. Happy path — two mount targets, one delete fails non-fatally
 *   4. Edge case — poll cap reached before mount targets drain (max 30 polls)
 *   5. Edge case — DescribeMountTargets throws → warn efs_mount_target_cleanup_failed
 *   6. Edge case — individual DeleteMountTarget throws → warn and continue
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { efsFileSystemStrategy } from "./efs-filesystem.js";
import type { DestroyContext } from "../types.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockEfsSend, mockEfsDestroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockEfsSend: vi.fn(),
    mockEfsDestroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-efs", () => {
  class EFSClient {
    send = mockEfsSend;
    destroy = mockEfsDestroy;
  }
  function DescribeMountTargetsCommand(input: unknown) {
    return { _type: "DescribeMountTargetsCommand", input };
  }
  function DeleteMountTargetCommand(input: unknown) {
    return { _type: "DeleteMountTargetCommand", input };
  }
  return { EFSClient, DescribeMountTargetsCommand, DeleteMountTargetCommand };
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

const FS_ID = "fs-0abc123456789def0";
const FS_ARN = `arn:aws:elasticfilesystem:us-east-1:210987654321:file-system/${FS_ID}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: FS_ARN,
      resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
      identifier: FS_ID,
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
  mockEfsSend.mockReset();
  mockEfsDestroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Iteratively settles a promise that polls under fake timers. Required
 * because `vi.runAllTimersAsync()` only sees timers queued at invocation,
 * but the strategy's `await import()` + initial mock awaits enqueue the
 * first setTimeout AFTER several microtask hops. We loop: drain microtasks,
 * advance fake time, drain again — until the promise settles or we hit
 * a generous safety cap.
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
    // Drain microtasks (yields to strategy's awaits)
    for (let j = 0; j < 5; j++) await Promise.resolve();
    // Advance fake time enough to fire any pending setTimeout
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

// ── 1. Happy path — no mount targets ─────────────────────────────────

describe("efsFileSystemStrategy.preDestroy — no mount targets", () => {
  it("returns void without any DeleteMountTarget or poll calls", async () => {
    mockEfsSend.mockResolvedValueOnce({ MountTargets: [] });

    const ctx = makeCtx();
    const result = await efsFileSystemStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    // Only the initial Describe call
    expect(mockEfsSend).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 2. Happy path — one mount target deleted then confirmed ───────────

describe("efsFileSystemStrategy.preDestroy — one mount target", () => {
  it("deletes mount target and breaks poll when Describe returns empty list", async () => {
    const MT_ID = "fsmt-0abc123456789def0";
    mockEfsSend
      .mockResolvedValueOnce({ MountTargets: [{ MountTargetId: MT_ID }] }) // initial Describe
      .mockResolvedValueOnce({}) // DeleteMountTarget
      .mockResolvedValueOnce({ MountTargets: [] }); // poll: all gone

    const ctx = makeCtx();
    const preDestroyPromise = efsFileSystemStrategy.preDestroy!(ctx);
    await flushUntilSettled(preDestroyPromise);
    await preDestroyPromise;

    expect(ctx.warn).not.toHaveBeenCalled();
    // 1 Describe + 1 Delete + 1 poll-Describe = 3
    expect(mockEfsSend).toHaveBeenCalledTimes(3);
  });
});

// ── 3. Happy path — two targets, one delete fails non-fatally ─────────

describe("efsFileSystemStrategy.preDestroy — partial delete failure", () => {
  it("warns efs_mount_target_delete_failed for failed target but continues", async () => {
    const MT_GOOD = "fsmt-good0000000000";
    const MT_BAD = "fsmt-bad11111111111";
    mockEfsSend
      .mockResolvedValueOnce({
        MountTargets: [{ MountTargetId: MT_GOOD }, { MountTargetId: MT_BAD }],
      })
      .mockResolvedValueOnce({}) // delete MT_GOOD
      .mockRejectedValueOnce(new Error("MountTargetConflict")) // delete MT_BAD fails
      .mockResolvedValueOnce({ MountTargets: [] }); // poll

    const ctx = makeCtx();
    const promise = efsFileSystemStrategy.preDestroy!(ctx);
    await flushUntilSettled(promise);
    await promise;

    expect(ctx.warn).toHaveBeenCalledWith(
      "efs_mount_target_delete_failed",
      expect.objectContaining({ mountTargetId: MT_BAD }),
    );
  });
});

// ── 4. Poll cap reached before mount targets drain ────────────────────

describe("efsFileSystemStrategy.preDestroy — poll cap exceeded", () => {
  it("stops polling after max attempts without warning (exits gracefully)", async () => {
    const MT_ID = "fsmt-stuck00000000";
    // Initial describe + delete + 30 poll-describe calls always returning a target
    mockEfsSend
      .mockResolvedValueOnce({ MountTargets: [{ MountTargetId: MT_ID }] }) // initial Describe
      .mockResolvedValueOnce({}) // Delete
      .mockResolvedValue({ MountTargets: [{ MountTargetId: MT_ID }] }); // all polls still have target

    const ctx = makeCtx();
    const promise = efsFileSystemStrategy.preDestroy!(ctx);
    await flushUntilSettled(promise);
    const result = await promise;

    // Strategy shouldn't throw or return hard failure — just exits after cap
    expect(result).toBeUndefined();
    // No mount-target-cleanup-failed warn (it only fires on initial Describe failure)
    expect(ctx.warn).not.toHaveBeenCalledWith(
      "efs_mount_target_cleanup_failed",
      expect.anything(),
    );
  });
});

// ── 5. DescribeMountTargets throws → outer catch ────────────────────

describe("efsFileSystemStrategy.preDestroy — outer error catch", () => {
  it("warns efs_mount_target_cleanup_failed when DescribeMountTargets throws", async () => {
    mockEfsSend.mockRejectedValueOnce(
      new Error("AccessDenied: cannot list mount targets"),
    );

    const ctx = makeCtx();
    const result = await efsFileSystemStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "efs_mount_target_cleanup_failed",
      expect.objectContaining({ identifier: FS_ID }),
    );
  });
});

// ── 6. Mount target ID missing → skip without error ───────────────────

describe("efsFileSystemStrategy.preDestroy — mount target without ID", () => {
  it("skips mount targets with no MountTargetId gracefully", async () => {
    mockEfsSend
      .mockResolvedValueOnce({ MountTargets: [{ MountTargetId: undefined }] }) // no ID
      .mockResolvedValueOnce({ MountTargets: [] }); // poll

    const ctx = makeCtx();
    const promise = efsFileSystemStrategy.preDestroy!(ctx);
    await flushUntilSettled(promise);
    await promise;

    // DeleteMountTargetCommand should NOT be called (no valid ID)
    const deleteCalls = mockEfsSend.mock.calls.filter(
      (c) => c[0]?._type === "DeleteMountTargetCommand",
    );
    expect(deleteCalls).toHaveLength(0);
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("efsFileSystemStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(efsFileSystemStrategy.resourceType).toBe(
      RESOURCE_TYPES.EFS_FILE_SYSTEM,
    );
  });

  it("exposes only a preDestroy hook", () => {
    expect(typeof efsFileSystemStrategy.preDestroy).toBe("function");
    expect(efsFileSystemStrategy.destroy).toBeUndefined();
    expect(efsFileSystemStrategy.postDestroy).toBeUndefined();
  });
});
