/**
 * Tests for cloudfront-setup.ts — CloudFront distribution + OAC creation
 *
 * @see Epic 37
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const { mockCfSend } = vi.hoisted(() => ({
  mockCfSend: vi.fn(),
}));

// ── Mock operator credentials ─────────────────────────────────────────────────
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  })),
}));

// ── Mock @aws-sdk/client-cloudfront ───────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudfront", () => {
  class MockCloudFrontClient {
    send = mockCfSend;
  }
  return {
    CloudFrontClient: MockCloudFrontClient,
    CreateOriginAccessControlCommand: vi
      .fn()
      .mockImplementation((input) => ({ _type: "CreateOAC", ...input })),
    CreateDistributionWithTagsCommand: vi
      .fn()
      .mockImplementation((input) => ({
        _type: "CreateDistWithTags",
        ...input,
      })),
    TagResourceCommand: vi.fn(),
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────
import {
  createCloudFrontDistribution,
  generateCloudFrontBucketPolicy,
} from "../cloudfront-setup.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createCloudFrontDistribution", () => {
  it("creates OAC and returns distribution ID, DomainName, ARN", async () => {
    // CreateOriginAccessControl
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: "oac-123" },
    });
    // CreateDistributionWithTags
    mockCfSend.mockResolvedValueOnce({
      Distribution: {
        Id: "dist-abc",
        DomainName: "d1234.cloudfront.net",
        ARN: "arn:aws:cloudfront::123456:distribution/dist-abc",
      },
    });

    const result = await createCloudFrontDistribution(
      "my-site-bucket",
      "us-east-1",
    );

    expect(result.distributionId).toBe("dist-abc");
    expect(result.domainName).toBe("d1234.cloudfront.net");
    expect(result.distributionArn).toBe(
      "arn:aws:cloudfront::123456:distribution/dist-abc",
    );
  });

  it("passes correct parameters to CreateDistributionWithTags", async () => {
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: "oac-456" },
    });
    mockCfSend.mockResolvedValueOnce({
      Distribution: {
        Id: "dist-xyz",
        DomainName: "d5678.cloudfront.net",
        ARN: "arn:aws:cloudfront::123456:distribution/dist-xyz",
      },
    });

    await createCloudFrontDistribution("test-bucket", "eu-west-1");

    // Verify the second call (CreateDistributionWithTags)
    const createDistCall = mockCfSend.mock.calls[1]![0];
    const distConfig =
      createDistCall.DistributionConfigWithTags.DistributionConfig;
    const tags = createDistCall.DistributionConfigWithTags.Tags;

    // OAC ID is threaded through
    const origin = distConfig.Origins.Items[0];
    expect(origin.OriginAccessControlId).toBe("oac-456");

    // Origin domain matches bucket + region
    expect(origin.DomainName).toBe("test-bucket.s3.eu-west-1.amazonaws.com");

    // DefaultRootObject
    expect(distConfig.DefaultRootObject).toBe("index.html");

    // HTTPS redirect
    expect(distConfig.DefaultCacheBehavior.ViewerProtocolPolicy).toBe(
      "redirect-to-https",
    );

    // Tags
    expect(tags.Items).toEqual(
      expect.arrayContaining([
        { Key: "managed-by", Value: "assignee-ai" },
        { Key: "assignee-bucket", Value: "test-bucket" },
      ]),
    );
  });

  it("throws when OAC creation returns no ID", async () => {
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: undefined },
    });

    await expect(
      createCloudFrontDistribution("bad-bucket", "us-east-1"),
    ).rejects.toThrow("returned no OAC ID");
  });

  it("throws when distribution response is incomplete (missing Id)", async () => {
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: "oac-ok" },
    });
    mockCfSend.mockResolvedValueOnce({
      Distribution: {
        Id: undefined,
        DomainName: "d1234.cloudfront.net",
        ARN: "arn:aws:cloudfront::123456:distribution/x",
      },
    });

    await expect(
      createCloudFrontDistribution("bucket", "us-east-1"),
    ).rejects.toThrow("incomplete response");
  });

  it("throws when distribution response is incomplete (missing DomainName)", async () => {
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: "oac-ok" },
    });
    mockCfSend.mockResolvedValueOnce({
      Distribution: {
        Id: "dist-123",
        DomainName: undefined,
        ARN: "arn:aws:cloudfront::123456:distribution/dist-123",
      },
    });

    await expect(
      createCloudFrontDistribution("bucket", "us-east-1"),
    ).rejects.toThrow("incomplete response");
  });

  it("throws when distribution response is incomplete (missing ARN)", async () => {
    mockCfSend.mockResolvedValueOnce({
      OriginAccessControl: { Id: "oac-ok" },
    });
    mockCfSend.mockResolvedValueOnce({
      Distribution: {
        Id: "dist-123",
        DomainName: "d1234.cloudfront.net",
        ARN: undefined,
      },
    });

    await expect(
      createCloudFrontDistribution("bucket", "us-east-1"),
    ).rejects.toThrow("incomplete response");
  });
});

describe("generateCloudFrontBucketPolicy", () => {
  it("returns valid JSON with correct structure", () => {
    const policyStr = generateCloudFrontBucketPolicy(
      "my-bucket",
      "arn:aws:cloudfront::123456:distribution/dist-abc",
    );

    const policy = JSON.parse(policyStr);
    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(1);

    const stmt = policy.Statement[0];
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Principal.Service).toBe("cloudfront.amazonaws.com");
    expect(stmt.Action).toBe("s3:GetObject");
  });

  it("uses aws:SourceArn condition key (uppercase AWS)", () => {
    const policyStr = generateCloudFrontBucketPolicy(
      "my-bucket",
      "arn:aws:cloudfront::123456:distribution/dist-abc",
    );

    const policy = JSON.parse(policyStr);
    const condition = policy.Statement[0].Condition;
    expect(condition.StringEquals).toBeDefined();
    // The key should be "aws:SourceArn" (lowercase aws prefix per AWS IAM condition key spec)
    expect(condition.StringEquals["aws:SourceArn"]).toBe(
      "arn:aws:cloudfront::123456:distribution/dist-abc",
    );
  });

  it("resource matches arn:aws:s3:::bucket/*", () => {
    const policyStr = generateCloudFrontBucketPolicy(
      "example-site",
      "arn:aws:cloudfront::123456:distribution/dist-xyz",
    );

    const policy = JSON.parse(policyStr);
    expect(policy.Statement[0].Resource).toBe("arn:aws:s3:::example-site/*");
  });
});
