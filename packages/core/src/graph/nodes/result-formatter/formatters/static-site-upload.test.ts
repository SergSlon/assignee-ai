/**
 * Unit tests for static-site-upload formatter helpers.
 *
 * Key coverage: printStaticWebsiteCloudFrontUrl must use
 * ResourceResult.metadata.cloudFrontDomainName (the real DNS-resolvable
 * hostname) and must NOT use the distribution ID to construct the URL.
 *
 * Bug fixed: https://github.com/assignee-ai/assignee/issues/<n>
 * Before fix: `https://E3B1MIRNBPH9JG.cloudfront.net` (NXDOMAIN)
 * After fix:  `https://d1eka2i9dtl8tu.cloudfront.net` (resolves correctly)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@/schema/graph-state.js";
import { RESOURCE_TYPES } from "@/index.js";
import type { ResourceResult } from "@/index.js";
import {
  printStaticWebsiteCloudFrontUrl,
  parseBucketName,
} from "./static-site-upload.js";

// ── CloudFront SDK mock (B4 — dynamic GetDistribution fallback) ────────────────
// The fallback path in printStaticWebsiteCloudFrontUrl now calls
// GetDistributionCommand when DomainName is absent. We mock the SDK
// at the module level so individual tests can override it.
const { mockCfSend } = vi.hoisted(() => ({
  mockCfSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-cloudfront", () => {
  class CloudFrontClient {
    send = mockCfSend;
  }
  function GetDistributionCommand(input: unknown) {
    return { _type: "GetDistributionCommand", input };
  }
  return { CloudFrontClient, GetDistributionCommand };
});

// ── stdout capture helper ─────────────────────────────────────────────────────

let capturedOutput: string;

beforeEach(() => {
  capturedOutput = "";
  vi.clearAllMocks();
  // Default: GetDistribution fails (so tests using the happy-path metadata
  // don't accidentally trigger the live fallback).
  mockCfSend.mockRejectedValue(
    new Error("GetDistribution should not be called in this test"),
  );
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    capturedOutput += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal ResourceResult for a CloudFront distribution with DomainName metadata. */
function makeDistributionResult(
  overrides: Partial<ResourceResult> = {},
): ResourceResult {
  return {
    resourceId: "cloudfront-distribution",
    resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    resourceArn: "E1234567890ABC",
    executionStatus: ExecutionStatus.SUCCESS,
    metadata: {
      cloudFrontDomainName: "d1abcdef.cloudfront.net",
    },
    ...overrides,
  };
}

function makeS3Result(): ResourceResult {
  return {
    resourceId: "static-site-bucket",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    resourceArn: "my-static-site-bucket",
    executionStatus: ExecutionStatus.SUCCESS,
  };
}

// ── printStaticWebsiteCloudFrontUrl ──────────────────────────────────────────

describe("printStaticWebsiteCloudFrontUrl", () => {
  describe("happy path — DomainName available in metadata", () => {
    it("prints the real DomainName as the URL, not the distribution ID", async () => {
      const resources: ResourceResult[] = [
        makeS3Result(),
        makeDistributionResult(),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      // Must contain the real DomainName
      expect(capturedOutput).toContain("d1abcdef.cloudfront.net");
      // Must NOT use the distribution ID as part of a .cloudfront.net URL
      expect(capturedOutput).not.toContain("E1234567890ABC.cloudfront.net");
    });

    it("prints a cyan announcement line with the correct URL", async () => {
      await printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain(
        "CloudFront distribution created: https://d1abcdef.cloudfront.net",
      );
    });

    it("prints a green Recommended URL line with the correct URL", async () => {
      await printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain(
        "Recommended URL: https://d1abcdef.cloudfront.net",
      );
    });

    it("prints the distribution ID on the Distribution ID line (for reference)", async () => {
      await printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain("Distribution ID: E1234567890ABC");
    });

    it("prints the propagating status line", async () => {
      await printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain("propagating");
      expect(capturedOutput).toContain("5-15 minutes");
    });

    it("the printed hostname matches ^[a-z0-9]+\\.cloudfront\\.net$ (lowercase, no ID)", async () => {
      // Use a fixture that mirrors the real bug evidence (uppercase distribution ID)
      const resources: ResourceResult[] = [
        makeDistributionResult({
          resourceArn: "E3B1MIRNBPH9JG",
          metadata: { cloudFrontDomainName: "d1eka2i9dtl8tu.cloudfront.net" },
        }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      // Extract the URL from the output and validate the hostname regex
      const urlMatch = capturedOutput.match(/https:\/\/([^\s\n]+)/);
      expect(urlMatch).not.toBeNull();
      const hostname = urlMatch![1];
      expect(hostname).toMatch(/^[a-z0-9]+\.cloudfront\.net$/);
    });
  });

  describe("fallback path — DomainName NOT available in metadata", () => {
    it("fetches DomainName via GetDistribution when metadata is missing and prints URL", async () => {
      // B4 (S-H-012): when DomainName is absent in metadata, the function
      // calls GetDistribution live and prints the URL on success.
      mockCfSend.mockResolvedValueOnce({
        Distribution: {
          DomainName: "d9xyz999.cloudfront.net",
          Id: "E1234567890ABC",
        },
        $metadata: { httpStatusCode: 200 },
      });
      const resources: ResourceResult[] = [
        makeDistributionResult({ metadata: undefined }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      // Must contain the fetched DomainName as URL
      expect(capturedOutput).toContain("d9xyz999.cloudfront.net");
      // Must NOT produce a broken <id>.cloudfront.net URL
      expect(capturedOutput).not.toContain("E1234567890ABC.cloudfront.net");
      // Must NOT contain the aws CLI command — that was the old leak
      expect(capturedOutput).not.toContain("aws cloudfront get-distribution");
    });

    it("prints 'URL not yet available' when GetDistribution fails (no aws CLI leak)", async () => {
      // B4 (S-H-012): when GetDistribution throws, print a clean degraded
      // message — do NOT leak the internal `aws cloudfront get-distribution`
      // CLI fragment (that exposes dev-internal tooling to the user).
      mockCfSend.mockRejectedValueOnce(new Error("AccessDeniedException"));
      const resources: ResourceResult[] = [
        makeDistributionResult({ metadata: undefined }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toContain("URL not yet available");
      expect(capturedOutput).toContain("E1234567890ABC");
      // Must NOT leak the aws CLI command
      expect(capturedOutput).not.toContain("aws cloudfront get-distribution");
    });

    it("prints degraded message when cloudFrontDomainName is undefined and GetDistribution returns no DomainName", async () => {
      // GetDistribution returns a response but Distribution.DomainName is absent.
      mockCfSend.mockResolvedValueOnce({
        Distribution: { Id: "E1234567890ABC" }, // no DomainName
        $metadata: { httpStatusCode: 200 },
      });
      const resources: ResourceResult[] = [
        makeDistributionResult({
          metadata: { cloudFrontDomainName: undefined },
        }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toContain("URL not yet available");
      expect(capturedOutput).not.toContain(".cloudfront.net\n"); // no broken URL
    });
  });

  describe("edge cases", () => {
    it("returns early without output if no CloudFront distribution in completedResources", async () => {
      const resources: ResourceResult[] = [makeS3Result()];

      await printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toBe("");
    });

    it("returns early without output if completedResources is empty", async () => {
      await printStaticWebsiteCloudFrontUrl([]);

      expect(capturedOutput).toBe("");
    });

    it("returns early if the CloudFront entry has no resourceArn", async () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({ resourceArn: undefined }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toBe("");
    });

    it("uses the first CloudFront distribution found when multiple are present", async () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({
          resourceId: "cf-dist-1",
          resourceArn: "EFIRST",
          metadata: { cloudFrontDomainName: "dfirst.cloudfront.net" },
        }),
        makeDistributionResult({
          resourceId: "cf-dist-2",
          resourceArn: "ESECOND",
          metadata: { cloudFrontDomainName: "dsecond.cloudfront.net" },
        }),
      ];

      await printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toContain("dfirst.cloudfront.net");
      // Second distribution should not appear in URL lines
      expect(capturedOutput).not.toContain("dsecond.cloudfront.net");
    });
  });
});

// ── parseBucketName ───────────────────────────────────────────────────────────

describe("parseBucketName", () => {
  it("returns the bare bucket name when the identifier is not an ARN", () => {
    expect(parseBucketName("my-bucket-name")).toBe("my-bucket-name");
  });

  it("extracts the bucket name from a full S3 ARN", () => {
    expect(parseBucketName("arn:aws:s3:::my-bucket-name")).toBe(
      "my-bucket-name",
    );
  });

  it("returns empty string for a malformed ARN with no content after :::", () => {
    expect(parseBucketName("arn:aws:s3:::")).toBe("");
  });
});
