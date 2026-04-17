/**
 * Tests for s3-bucket destroy strategy — chunked empty, AccessDenied
 * fail-loud, and V1 N5 truncated-without-marker guard.
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({ mockS3Send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = hoisted.mockS3Send;
    destroy = vi.fn();
  }
  function ListObjectVersionsCommand(i: Record<string, unknown>) {
    return { _type: "ListObjectVersions", ...i };
  }
  function DeleteObjectsCommand(i: Record<string, unknown>) {
    return { _type: "DeleteObjects", ...i };
  }
  return { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand };
});

import { s3BucketStrategy } from "@assignee/core";
import type { DestroyContext } from "@assignee/core";

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

function makeCtx(): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:s3:::test-bucket",
      resourceType: "AWS::S3::Bucket",
      identifier: "test-bucket",
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

describe("s3BucketStrategy", () => {
  it("deletes versions + delete-markers in 1000-key chunks", async () => {
    // 1500 versions + 700 delete markers = 2200 objects → 3 chunks of ≤1000.
    const versions = Array.from({ length: 1500 }, (_, i) => ({
      Key: `k${i}`,
      VersionId: `v${i}`,
    }));
    const deleteMarkers = Array.from({ length: 700 }, (_, i) => ({
      Key: `dm${i}`,
      VersionId: `dv${i}`,
    }));
    hoisted.mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "ListObjectVersions") {
        return {
          Versions: versions,
          DeleteMarkers: deleteMarkers,
          IsTruncated: false,
        };
      }
      return {};
    });

    const outcome = await s3BucketStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const deleteCalls = hoisted.mockS3Send.mock.calls.filter(
      (c) => c[0]._type === "DeleteObjects",
    );
    expect(deleteCalls).toHaveLength(3);
    expect(deleteCalls[0]![0].Delete.Objects).toHaveLength(1000);
    expect(deleteCalls[1]![0].Delete.Objects).toHaveLength(1000);
    expect(deleteCalls[2]![0].Delete.Objects).toHaveLength(200);
  });

  it("promotes AccessDenied to a hard failure (Wave 19 Bug #3)", async () => {
    const err = new Error("Access Denied");
    (err as { name?: string }).name = "AccessDenied";
    hoisted.mockS3Send.mockRejectedValue(err);

    const outcome = await s3BucketStrategy.preDestroy!(makeCtx());
    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("s3:ListBucketVersions");
    expect(outcome?.error).toContain("assignee setup");
  });

  it("breaks out of the loop if IsTruncated=true but both markers are missing (V1 N5)", async () => {
    let calls = 0;
    hoisted.mockS3Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "ListObjectVersions") {
        calls++;
        // Malformed response: truncated=true without markers
        return {
          Versions: [{ Key: "k0", VersionId: "v0" }],
          DeleteMarkers: [],
          IsTruncated: true,
          NextKeyMarker: undefined,
          NextVersionIdMarker: undefined,
        };
      }
      return {};
    });

    const outcome = await s3BucketStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    // Must not spin forever — only one ListObjectVersions call.
    expect(calls).toBe(1);
  });
});
