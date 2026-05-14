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
 *
 * DC-2 variations (destroy-correctness-2-s3-versioned-objects spec):
 *   A. 10 versioned objects → single DeleteObjects batch
 *   B. 1500 objects across 2 pages → 2 DeleteObjects calls (1000 + 500)
 *   C. Empty bucket → no DeleteObjects call, direct DeleteBucket (via CCAPI)
 *   D. 5 versions + 3 delete markers → all 8 items in DeleteObjects payload
 *   E. Non-versioned bucket → same path, no regression (safe for ListObjectVersions)
 *   F. BucketPolicy companion present → BucketPolicy deleted before bucket
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { s3BucketStrategy } from "./s3-bucket.js";
import type { DestroyContext } from "../types.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const {
  mockS3Send,
  mockS3Destroy,
  mockRequireAssigneeCredentials,
  mockListProvisionRecords,
  mockCcSend,
  mockCcDestroy,
} = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockS3Destroy: vi.fn(),
  mockRequireAssigneeCredentials: vi.fn(),
  mockListProvisionRecords: vi.fn(),
  mockCcSend: vi.fn(),
  mockCcDestroy: vi.fn(),
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

vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class CloudControlClient {
    send = mockCcSend;
    destroy = mockCcDestroy;
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

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: mockRequireAssigneeCredentials,
  MissingAssigneeCredentialsError: class MissingAssigneeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MissingAssigneeCredentialsError";
    }
  },
}));

vi.mock("../../managed-resources/store.js", () => ({
  listProvisionRecords: mockListProvisionRecords,
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
  mockCcSend.mockReset();
  mockCcDestroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  // Default: no BucketPolicy companion in provision log
  mockListProvisionRecords.mockResolvedValue([]);
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

// ── DC-2 Variation A — 10 versioned objects, single DeleteObjects ──────

describe("DC-2 Variation A — versioned bucket with 10 objects", () => {
  it("batches all 10 versions into a single DeleteObjects call", async () => {
    const versions = Array.from({ length: 10 }, (_, i) => ({
      Key: `file-${i}.txt`,
      VersionId: `ver-${i}`,
    }));
    mockS3Send
      .mockResolvedValueOnce({
        Versions: versions,
        DeleteMarkers: [],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Deleted: versions.map((v) => ({ Key: v.Key })),
      });

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    const deleteCalls = mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjectsCommand",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![0].input.Delete.Objects).toHaveLength(10);
    expect(deleteCalls[0]![0].input.Delete.Objects[0]).toMatchObject({
      Key: "file-0.txt",
      VersionId: "ver-0",
    });
  });
});

// ── DC-2 Variation B — 1500 objects across 2 pages ────────────────────

describe("DC-2 Variation B — versioned bucket with 1500 objects across 2 pages", () => {
  it("paginates and calls DeleteObjects twice (1000 + 500)", async () => {
    const page1Versions = Array.from({ length: 1000 }, (_, i) => ({
      Key: `obj-${i}`,
      VersionId: `v${i}`,
    }));
    const page2Versions = Array.from({ length: 500 }, (_, i) => ({
      Key: `obj-${1000 + i}`,
      VersionId: `v${1000 + i}`,
    }));

    mockS3Send
      // Page 1: 1000 versions, truncated
      .mockResolvedValueOnce({
        Versions: page1Versions,
        DeleteMarkers: [],
        IsTruncated: true,
        NextKeyMarker: "obj-999",
        NextVersionIdMarker: "v999",
      })
      // DeleteObjects for page 1 (1000 objects)
      .mockResolvedValueOnce({ Deleted: [] })
      // Page 2: 500 versions, not truncated
      .mockResolvedValueOnce({
        Versions: page2Versions,
        DeleteMarkers: [],
        IsTruncated: false,
      })
      // DeleteObjects for page 2 (500 objects)
      .mockResolvedValueOnce({ Deleted: [] });

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    const deleteCalls = mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjectsCommand",
    );
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]![0].input.Delete.Objects).toHaveLength(1000);
    expect(deleteCalls[1]![0].input.Delete.Objects).toHaveLength(500);
  });
});

// ── DC-2 Variation C — empty bucket ───────────────────────────────────

describe("DC-2 Variation C — empty bucket", () => {
  it("calls ListObjectVersions once, no DeleteObjects, proceeds to bucket delete", async () => {
    mockS3Send.mockResolvedValueOnce(emptyListResponse());

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    const deleteCalls = mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjectsCommand",
    );
    expect(deleteCalls).toHaveLength(0);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });
});

// ── DC-2 Variation D — 5 versions + 3 delete markers ─────────────────

describe("DC-2 Variation D — bucket with 5 versions and 3 delete markers", () => {
  it("includes all 8 items (versions + markers) in the DeleteObjects payload", async () => {
    const versions = Array.from({ length: 5 }, (_, i) => ({
      Key: `doc-${i}.pdf`,
      VersionId: `ver-${i}`,
    }));
    const markers = Array.from({ length: 3 }, (_, i) => ({
      Key: `deleted-${i}.txt`,
      VersionId: `dm-${i}`,
    }));

    mockS3Send
      .mockResolvedValueOnce({
        Versions: versions,
        DeleteMarkers: markers,
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Deleted: [] });

    const ctx = makeCtx();
    await s3BucketStrategy.preDestroy!(ctx);

    const deleteCalls = mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjectsCommand",
    );
    expect(deleteCalls).toHaveLength(1);
    const objects = deleteCalls[0]![0].input.Delete.Objects;
    expect(objects).toHaveLength(8);
    // Versions come first, then delete markers
    expect(objects[0]).toMatchObject({ Key: "doc-0.pdf", VersionId: "ver-0" });
    expect(objects[5]).toMatchObject({
      Key: "deleted-0.txt",
      VersionId: "dm-0",
    });
  });
});

// ── DC-2 Variation E — non-versioned bucket ───────────────────────────

describe("DC-2 Variation E — non-versioned bucket (no regression)", () => {
  it("runs ListObjectVersions (safe for non-versioned), deletes returned objects, proceeds normally", async () => {
    // Non-versioned bucket: ListObjectVersions returns objects without VersionId
    const plainObjects = Array.from({ length: 3 }, (_, i) => ({
      Key: `plain-${i}.txt`,
      VersionId: undefined,
    }));

    mockS3Send
      .mockResolvedValueOnce({
        Versions: plainObjects,
        DeleteMarkers: [],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Deleted: [] });

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    const deleteCalls = mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjectsCommand",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![0].input.Delete.Objects).toHaveLength(3);
  });
});

// ── DC-2 Variation F — BucketPolicy companion present ─────────────────

describe("DC-2 Variation F — BucketPolicy companion present", () => {
  it("deletes companion BucketPolicy via CCAPI before proceeding to bucket empty", async () => {
    // Provision log has a BucketPolicy companion keyed by bucket name
    mockListProvisionRecords.mockResolvedValue([
      {
        keyKind: "primaryIdentifier",
        key: BUCKET_NAME,
        resourceType: RESOURCE_TYPES.S3_BUCKET_POLICY,
        region: "us-east-1",
        createdDate: "2026-05-14T00:00:00.000Z",
        estimatedMonthlyCost: "$0.00",
        runId: "abc123",
      },
    ]);

    // CloudControl: DeleteResource returns a requestToken, then poll SUCCESS
    mockCcSend
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "token-bucket-policy-1" },
      })
      .mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
      });

    // S3: empty bucket after policy delete
    mockS3Send.mockResolvedValueOnce(emptyListResponse());

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();

    // CCAPI delete was called with BucketPolicy type + bucket name identifier
    expect(mockCcSend).toHaveBeenCalledTimes(2);
    const deleteResourceCall = mockCcSend.mock.calls[0]![0];
    expect(deleteResourceCall._type).toBe("DeleteResourceCommand");
    expect(deleteResourceCall.input).toMatchObject({
      TypeName: RESOURCE_TYPES.S3_BUCKET_POLICY,
      Identifier: BUCKET_NAME,
    });

    // S3 operations still ran (bucket emptying)
    expect(mockS3Send).toHaveBeenCalledTimes(1);

    // Progress was reported
    const progressCalls = (ctx.onProgress as ReturnType<typeof vi.fn>).mock
      .calls;
    const policyProgressCall = progressCalls.find((c) =>
      String(c[0]).includes("BucketPolicy"),
    );
    expect(policyProgressCall).toBeDefined();
  });

  it("proceeds normally (no abort) if BucketPolicy companion is not in provision log", async () => {
    mockListProvisionRecords.mockResolvedValue([]);
    mockS3Send.mockResolvedValueOnce(emptyListResponse());

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    // No CCAPI calls were made (no companion found)
    expect(mockCcSend).not.toHaveBeenCalled();
  });

  it("does not abort bucket destroy if BucketPolicy CCAPI delete fails (non-fatal)", async () => {
    mockListProvisionRecords.mockResolvedValue([
      {
        keyKind: "primaryIdentifier",
        key: BUCKET_NAME,
        resourceType: RESOURCE_TYPES.S3_BUCKET_POLICY,
        region: "us-east-1",
        createdDate: "2026-05-14T00:00:00.000Z",
        estimatedMonthlyCost: "$0.00",
        runId: "abc123",
      },
    ]);

    // CCAPI delete succeeds but poll returns FAILED
    mockCcSend
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "token-policy-fail" },
      })
      .mockResolvedValueOnce({
        ProgressEvent: {
          OperationStatus: "FAILED",
          ErrorCode: "InternalFailure",
          StatusMessage: "Unexpected error",
        },
      });

    // S3 empty-bucket still runs
    mockS3Send.mockResolvedValueOnce(emptyListResponse());

    const ctx = makeCtx();
    const result = await s3BucketStrategy.preDestroy!(ctx);

    // Bucket destroy was NOT aborted
    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "s3_bucket_policy_delete_failed",
      expect.objectContaining({ bucketName: BUCKET_NAME }),
    );
    // S3 operations still ran
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });
});
