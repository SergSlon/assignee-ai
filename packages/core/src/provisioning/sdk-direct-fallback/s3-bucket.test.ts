/**
 * Tests for sdk-direct S3 Bucket fallback (W5-04).
 * All AWS SDK calls are mocked — no real AWS interaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createS3BucketSdkDirect,
  SDK_DIRECT_COMPLETE_TOKEN,
} from "./s3-bucket.js";

// Mock the AWS SDK S3Client
vi.mock("@aws-sdk/client-s3", () => {
  const sendMock = vi.fn().mockResolvedValue({});
  const S3Client = vi.fn().mockImplementation(() => ({ send: sendMock }));
  const CreateBucketCommand = vi
    .fn()
    .mockImplementation((input) => ({ input }));
  return { S3Client, CreateBucketCommand, BucketLocationConstraint: {} };
});

// Mock operator credentials
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: vi.fn().mockReturnValue({
    accessKeyId: "AKIAFAKEKEY",
    secretAccessKey: "fakeSecretKey",
    region: "us-east-1",
  }),
}));

describe("createS3BucketSdkDirect", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // vi.clearAllMocks() resets mockReturnValue/mockImplementation, so
    // re-apply both the operatorCredentials() return-value contract AND
    // the S3Client send-mock for every test.
    const { operatorCredentials } =
      await import("../../config/operator-credentials.js");
    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "AKIAFAKEKEY",
      secretAccessKey: "fakeSecretKey",
      region: "us-east-1",
    });
    const { S3Client } = await import("@aws-sdk/client-s3");
    vi.mocked(S3Client).mockImplementation(
      () => ({ send: vi.fn().mockResolvedValue({}) }) as never,
    );
  });

  it("creates a bucket and returns SDK_DIRECT_COMPLETE_TOKEN + bucket name", async () => {
    const result = await createS3BucketSdkDirect(
      JSON.stringify({ BucketName: "my-test-bucket" }),
      "eu-central-1",
    );
    expect(result.requestToken).toBe(SDK_DIRECT_COMPLETE_TOKEN);
    expect(result.identifier).toBe("my-test-bucket");
  });

  it("omits LocationConstraint for us-east-1 (AWS S3 constraint)", async () => {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    await createS3BucketSdkDirect(
      JSON.stringify({ BucketName: "us-bucket" }),
      "us-east-1",
    );
    const callArg = vi.mocked(CreateBucketCommand).mock
      .calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArg["CreateBucketConfiguration"]).toBeUndefined();
  });

  it("includes LocationConstraint for non-us-east-1 regions", async () => {
    const { CreateBucketCommand } = await import("@aws-sdk/client-s3");
    await createS3BucketSdkDirect(
      JSON.stringify({ BucketName: "eu-bucket" }),
      "eu-central-1",
    );
    const callArg = vi.mocked(CreateBucketCommand).mock
      .calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArg["CreateBucketConfiguration"]).toBeDefined();
  });

  it("throws an actionable error when BucketName is missing", async () => {
    await expect(
      createS3BucketSdkDirect(
        JSON.stringify({ SomeOtherProp: "value" }),
        "us-east-1",
      ),
    ).rejects.toThrow(/"BucketName" is required/);
  });

  it("throws an actionable error when desiredState is invalid JSON", async () => {
    await expect(
      createS3BucketSdkDirect("not-json", "us-east-1"),
    ).rejects.toThrow(/not valid JSON/);
  });
});
