import type { ArchitecturePattern } from "../types.js";

/**
 * Static Website pattern (S3 only for MVP).
 * Note: CloudFront, Route53, and ACM resources require domain configuration from the user
 * (cannot be provisioned with defaults). Omitted from this MVP implementation.
 * Story 8.2 can expand to include CloudFront as a follow-up.
 */
export const staticWebsitePattern: ArchitecturePattern = {
  patternId: "static-website",
  displayName: "Static Website (S3 + CloudFront)",
  keywords: [
    "static website",
    "static site",
    "s3 cloudfront",
    "cdn website",
    "frontend hosting",
    "spa hosting",
  ],
  resourceList: [
    {
      resourceType: "AWS::S3::Bucket",
      resourceId: "website-bucket",
      displayName: "S3 Website Bucket",
    },
  ],
  dependencyOrder: [["website-bucket"]],
  defaultOptions: {
    "website-bucket": {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
  },
};
