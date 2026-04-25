/**
 * Unit tests for the S3 Bucket destroy strategy.
 *
 * Covers:
 *   1. Happy path — empty bucket (no versions), preDestroy returns void
 *   2. Happy path — bucket with versions + delete markers (paginated)
 *   3. Happy path — chunked batch (>1000 objects in one page)
 *   4. Edge case — MissingAssigneeCredentialsError → hard failure
 *   5. Edge case — AccessDenied on ListBucketVersions → hard failure
 *   6. Edge case — other network error → warn + continue (non-fatal)
 *   7. Edge case — IsTruncated=true but both markers absent → guard breaks loop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { s3BucketStrategy } from "./s3-bucket.js";
import type { DestroyContext } from "../types.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockS3Send, mockS3Destroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockS3Destroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mockS3Send;
    destroy = mockS3Destroy;
  }
  function ListObjectVersionsCommand(input: unknown) {
    return { _type: "ListObjectVersionsCommand", input };
  }
  function DeleteObjectsCommand(input: unknown) {
    return { _type: "DeleteObjectsCommand", input };
  }
  return { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand };
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

const BUCKET_NAME = "assignee-test-bucket-20260416";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET_NAME}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: BUCKET_ARN,
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      identifier: BUCKET_NAME,
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

/** Simulate one page with no objects, IsTruncated=false */
function emptyListResponse() {
  return { Versions: [], DeleteMarkers: [], IsTruncated: false };
}

beforeEach(() => {
  mockS3Send.mockReset();
  mockS3Destroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. Happy path — empty bucket ──────────────────────────────────────

describe("s3BucketStrategy.preDestroy — empty bucket", () => {
  it("calls ListObjectVersions once and returns void (no DeleteObjects needed)", async () => {
    mockS3Send.mockResolvedValueOnce(emptyListResponse());

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Destroy).toHaveBeenCalledTimes(1);
  });
});

// ── 2. Happy path — versions + delete markers (single page) ──────────

describe("s3BucketStrategy.preDestroy — single-page with objects", () => {
  it("deletes all versions and delete markers in a single DeleteObjects call", async () => {
    mockS3Send
      .mockResolvedValueOnce({
        Versions: [{ Key: "file1.txt", VersionId: "v1" }],
        DeleteMarkers: [{ Key: "file2.txt", VersionId: "dm1" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Deleted: [{ Key: "file1.txt" }, { Key: "file2.txt" }],
      });

    const ctx = makeCtx();
    await s3BucketStrategy.preDestroy!(ctx);

    // First call: ListObjectVersions. Second: DeleteObjects.
    expect(mockS3Send).toHaveBeenCalledTimes(2);
    const deleteCall = mockS3Send.mock.calls[1];
    expect(deleteCall![0]).toMatchObject({
      _type: "DeleteObjectsCommand",
      input: {
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: [
            { Key: "file1.txt", VersionId: "v1" },
            { Key: "file2.txt", VersionId: "dm1" },
          ],
        },
      },
    });
  });
});

// ── 3. Edge case — chunked batch (>1000 objects per page) ─────────────

describe("s3BucketStrategy.preDestroy — large page chunking", () => {
  it("chunks objects into 1000-key batches for DeleteObjects", async () => {
    // 1500 versions → requires 2 DeleteObjects calls
    const versions = Array.from({ length: 1500 }, (_, i) => ({
      Key: `obj-${i}`,
      VersionId: `v${i}`,
    }));
    mockS3Send
      .mockResolvedValueOnce({
        Versions: versions,
        DeleteMarkers: [],
        IsTruncated: false,
      })
      // Two DeleteObjects calls
      .mockResolvedValueOnce({ Deleted: [] })
      .mockResolvedValueOnce({ Deleted: [] });

    const ctx = makeCtx();
    await s3BucketStrategy.preDestroy!(ctx);

    // 1 List + 2 Delete calls
    expect(mockS3Send).toHaveBeenCalledTimes(3);
    const firstChunk = mockS3Send.mock.calls[1]![0].input.Delete.Objects;
    const secondChunk = mockS3Send.mock.calls[2]![0].input.Delete.Objects;
    expect(firstChunk).toHaveLength(1000);
    expect(secondChunk).toHaveLength(500);
  });
});

// ── 4. Edge case — MissingAssigneeCredentialsError ────────────────────

describe("s3BucketStrategy.preDestroy — missing credentials", () => {
  it("returns hard failure with descriptive error", async () => {
    mockRequireAssigneeCredentials.mockImplementation(() => {
      throw new MissingAssigneeCredentialsError(
        "operator",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      );
    });

    const ctx = makeCtx();
    const outcome = await s3BucketStrategy.preDestroy!(ctx);

    expect(outcome).toBeDefined();
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("Cannot empty S3 bucket before delete");
  });
});

// ── 5. Edge case — AccessDenied on ListBucketVersions → hard failure ──

describe("s3BucketStrategy.preDestroy — AccessDenied", () => {
  it("returns hard failure with IAM guidance when ListBucketVersions is denied", async () => {
    const accessDeniedErr = Object.assign(new Error("AccessDenied"), {
      name: "AccessDeniedException",
      Code: "AccessDenied",
    });
    mockS3Send.mockRejectedValueOnce(accessDeniedErr);

    const ctx = makeCtx();
    const outcome = await s3BucketStrategy.preDestroy!(ctx);

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("s3:ListBucketVersions");
    expect(outcome?.error).toContain("operator role lacks");
  });
});

// ── 6. Edge case — non-fatal network error ────────────────────────────

describe("s3BucketStrategy.preDestroy — non-fatal error", () => {
  it("warns and returns undefined (continue to CCAPI delete) on throttling error", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("RequestThrottled: slow down"));

    const ctx = makeCtx();
    const outcome = await s3BucketStrategy.preDestroy!(ctx);

    expect(outcome).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "s3_empty_bucket_failed",
      expect.objectContaining({ identifier: BUCKET_NAME }),
    );
  });
});

// ── 7. Edge case — IsTruncated without markers → loop guard ──────────

describe("s3BucketStrategy.preDestroy — truncated-without-marker guard", () => {
  it("breaks out of pagination loop and warns when IsTruncated=true but markers absent", async () => {
    // First page: has objects + IsTruncated=true but NO markers
    mockS3Send
      .mockResolvedValueOnce({
        Versions: [{ Key: "trapped.txt", VersionId: "v1" }],
        DeleteMarkers: [],
        IsTruncated: true,
        // NextKeyMarker and NextVersionIdMarker intentionally absent
      })
      .mockResolvedValueOnce({ Deleted: [] }); // DeleteObjects call

    const ctx = makeCtx();
    await s3BucketStrategy.preDestroy!(ctx);

    expect(ctx.warn).toHaveBeenCalledWith(
      "s3_list_versions_truncated_without_marker",
      expect.objectContaining({ identifier: BUCKET_NAME }),
    );
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("s3BucketStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(s3BucketStrategy.resourceType).toBe(RESOURCE_TYPES.S3_BUCKET);
  });

  it("exposes a preDestroy hook and no destroy/postDestroy hooks", () => {
    expect(typeof s3BucketStrategy.preDestroy).toBe("function");
    expect(s3BucketStrategy.destroy).toBeUndefined();
    expect(s3BucketStrategy.postDestroy).toBeUndefined();
  });
});
