import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ArchitecturePattern } from "../types.js";

/**
 * Static Website pattern — S3 bucket + CloudFront distribution.
 * S3 is provisioned via CloudControl. CloudFront + OAC are created post-provision
 * via direct SDK calls (not CloudControl). File upload uses --source flag.
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
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      resourceId: "website-bucket",
      displayName: "S3 Website Bucket",
    },
    {
      resourceType: "AWS::CloudFront::Distribution",
      resourceId: "cdn-distribution",
      displayName: "CloudFront CDN (HTTPS)",
      provisionable: false, // Created post-provision via SDK when --source is used
    },
    {
      resourceType: "AWS::CloudFront::OriginAccessControl",
      resourceId: "cdn-oac",
      displayName: "Origin Access Control",
      provisionable: false, // Created alongside CloudFront distribution
    },
  ],
  dependencyOrder: [["website-bucket"], ["cdn-oac", "cdn-distribution"]],
  defaultOptions: {
    "website-bucket": {
      WebsiteConfiguration: {
        IndexDocument: "index.html",
        ErrorDocument: "error.html",
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      VersioningConfiguration: { Status: CfnKey.ENABLED },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: false,
        RestrictPublicBuckets: false,
      },
    },
  },
};
