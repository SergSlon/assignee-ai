/**
 * CloudFront Setup Service — creates a CloudFront distribution with OAC
 * for S3 static website hosting.
 *
 * Uses ASSIGNEE_OPERATOR_* credentials via operatorCredentials(), consistent with
 * all other AWS SDK clients in the CLI.
 *
 * @see Epic 37 — Static Website Pattern (CloudFront post-provision)
 */

import {
  CloudFrontClient,
  CreateDistributionWithTagsCommand,
  CreateOriginAccessControlCommand,
  TagResourceCommand,
} from "@aws-sdk/client-cloudfront";
import { ConfigurationError, AssigneeTag } from "@assignee/core";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { IamEffect } from "@assignee/core";
import { CredentialError } from "../config/constants.js";

export interface CloudFrontResult {
  distributionId: string;
  domainName: string; // e.g., d1234.cloudfront.net
  distributionArn: string;
}

/**
 * Create a CloudFrontClient using the same credential pattern as the rest of the CLI.
 */
function createCloudFrontClient(config: AwsConfig): CloudFrontClient {
  if (!config.accessKeyId) {
    throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
  }
  if (!config.secretAccessKey) {
    throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
  }
  if (!config.region) {
    throw new ConfigurationError("AWS_REGION is missing or empty");
  }
  // CloudFront is a global service but the client still needs a region for signing
  return new CloudFrontClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Creates a CloudFront distribution with OAC pointing to an S3 bucket.
 * Returns the distribution domain name for the website URL.
 *
 * Steps:
 * 1. Create an Origin Access Control (OAC) for S3
 * 2. Create a CloudFront distribution with the OAC attached
 * 3. Return the distribution info (ID, domain name, ARN)
 */
export async function createCloudFrontDistribution(
  bucketName: string,
  region: string,
): Promise<CloudFrontResult> {
  const creds = operatorCredentials();
  creds.region = region;
  const client = createCloudFrontClient(creds);

  // 1. Create Origin Access Control
  const callerReference = `assignee-oac-${bucketName}-${Date.now()}`;
  const oacResp = await client.send(
    new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: `assignee-oac-${bucketName}`,
        Description: `OAC for Assignee.ai static website: ${bucketName}`,
        SigningProtocol: "sigv4",
        SigningBehavior: "always",
        OriginAccessControlOriginType: "s3",
      },
    }),
  );

  const oacId = oacResp.OriginAccessControl?.Id;
  if (!oacId) {
    throw new Error("CloudFront CreateOriginAccessControl returned no OAC ID");
  }

  // 2. Create CloudFront distribution
  const originDomainName = `${bucketName}.s3.${region}.amazonaws.com`;
  const originId = `S3-${bucketName}`;
  const distCallerReference = `assignee-dist-${bucketName}-${Date.now()}`;

  const distResp = await client.send(
    new CreateDistributionWithTagsCommand({
      DistributionConfigWithTags: {
        DistributionConfig: {
          CallerReference: distCallerReference,
          Comment: `Assignee.ai static website: ${bucketName}`,
          Enabled: true,
          DefaultRootObject: "index.html",
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: originId,
                DomainName: originDomainName,
                OriginAccessControlId: oacId,
                S3OriginConfig: {
                  OriginAccessIdentity: "",
                },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: originId,
            ViewerProtocolPolicy: "redirect-to-https",
            AllowedMethods: {
              Quantity: 2,
              Items: ["GET", "HEAD"],
              CachedMethods: {
                Quantity: 2,
                Items: ["GET", "HEAD"],
              },
            },
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: "none" },
            },
            Compress: true,
            MinTTL: 0,
            DefaultTTL: 86400,
            MaxTTL: 31536000,
          },
          CustomErrorResponses: {
            Quantity: 1,
            Items: [
              {
                ErrorCode: 403,
                ResponsePagePath: "/index.html",
                ResponseCode: "200",
                ErrorCachingMinTTL: 10,
              },
            ],
          },
          PriceClass: "PriceClass_100",
        },
        Tags: {
          Items: [
            { Key: AssigneeTag.KEY, Value: AssigneeTag.VALUE },
            { Key: "assignee-bucket", Value: bucketName },
          ],
        },
      },
    }),
  );

  const dist = distResp.Distribution;
  if (!dist?.Id || !dist.DomainName || !dist.ARN) {
    throw new Error(
      "CloudFront CreateDistribution returned incomplete response",
    );
  }

  return {
    distributionId: dist.Id,
    domainName: dist.DomainName,
    distributionArn: dist.ARN,
  };
}

/**
 * Generates an S3 bucket policy that grants CloudFront OAC read access.
 * This replaces the public-read policy with a more secure OAC-based policy.
 */
export function generateCloudFrontBucketPolicy(
  bucketName: string,
  distributionArn: string,
): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowCloudFrontServicePrincipalReadOnly",
        Effect: IamEffect.ALLOW,
        Principal: {
          Service: "cloudfront.amazonaws.com",
        },
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${bucketName}/*`,
        Condition: {
          StringEquals: {
            "aws:SourceArn": distributionArn,
          },
        },
      },
    ],
  });
}
