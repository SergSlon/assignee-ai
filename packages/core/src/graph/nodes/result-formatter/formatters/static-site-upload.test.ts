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

// ── stdout capture helper ─────────────────────────────────────────────────────

let capturedOutput: string;

beforeEach(() => {
  capturedOutput = "";
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
    it("prints the real DomainName as the URL, not the distribution ID", () => {
      const resources: ResourceResult[] = [
        makeS3Result(),
        makeDistributionResult(),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      // Must contain the real DomainName
      expect(capturedOutput).toContain("d1abcdef.cloudfront.net");
      // Must NOT use the distribution ID as part of a .cloudfront.net URL
      expect(capturedOutput).not.toContain("E1234567890ABC.cloudfront.net");
    });

    it("prints a cyan announcement line with the correct URL", () => {
      printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain(
        "CloudFront distribution created: https://d1abcdef.cloudfront.net",
      );
    });

    it("prints a green Recommended URL line with the correct URL", () => {
      printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain(
        "Recommended URL: https://d1abcdef.cloudfront.net",
      );
    });

    it("prints the distribution ID on the Distribution ID line (for reference)", () => {
      printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain("Distribution ID: E1234567890ABC");
    });

    it("prints the propagating status line", () => {
      printStaticWebsiteCloudFrontUrl([makeDistributionResult()]);

      expect(capturedOutput).toContain("propagating");
      expect(capturedOutput).toContain("5-15 minutes");
    });

    it("the printed hostname matches ^[a-z0-9]+\\.cloudfront\\.net$ (lowercase, no ID)", () => {
      // Use a fixture that mirrors the real bug evidence (uppercase distribution ID)
      const resources: ResourceResult[] = [
        makeDistributionResult({
          resourceArn: "E3B1MIRNBPH9JG",
          metadata: { cloudFrontDomainName: "d1eka2i9dtl8tu.cloudfront.net" },
        }),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      // Extract the URL from the output and validate the hostname regex
      const urlMatch = capturedOutput.match(/https:\/\/([^\s\n]+)/);
      expect(urlMatch).not.toBeNull();
      const hostname = urlMatch![1];
      expect(hostname).toMatch(/^[a-z0-9]+\.cloudfront\.net$/);
    });
  });

  describe("fallback path — DomainName NOT available in metadata", () => {
    it("prints a fallback hint instead of a broken URL when metadata is missing", () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({ metadata: undefined }),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      // Must NOT produce a broken <id>.cloudfront.net URL
      expect(capturedOutput).not.toContain("E1234567890ABC.cloudfront.net");
      // Must contain a fallback hint with the aws cli command
      expect(capturedOutput).toContain("aws cloudfront get-distribution");
      expect(capturedOutput).toContain("E1234567890ABC");
    });

    it("prints a fallback hint when cloudFrontDomainName is undefined", () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({
          metadata: { cloudFrontDomainName: undefined },
        }),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toContain("aws cloudfront get-distribution");
      expect(capturedOutput).not.toContain(".cloudfront.net\n"); // no broken URL line ending
    });

    it("prints fallback hint including the distribution ID for manual lookup", () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({
          resourceArn: "EABCDEF123456",
          metadata: undefined,
        }),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toContain("EABCDEF123456");
      expect(capturedOutput).toContain("Distribution.DomainName");
    });
  });

  describe("edge cases", () => {
    it("returns early without output if no CloudFront distribution in completedResources", () => {
      const resources: ResourceResult[] = [makeS3Result()];

      printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toBe("");
    });

    it("returns early without output if completedResources is empty", () => {
      printStaticWebsiteCloudFrontUrl([]);

      expect(capturedOutput).toBe("");
    });

    it("returns early if the CloudFront entry has no resourceArn", () => {
      const resources: ResourceResult[] = [
        makeDistributionResult({ resourceArn: undefined }),
      ];

      printStaticWebsiteCloudFrontUrl(resources);

      expect(capturedOutput).toBe("");
    });

    it("uses the first CloudFront distribution found when multiple are present", () => {
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

      printStaticWebsiteCloudFrontUrl(resources);

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
