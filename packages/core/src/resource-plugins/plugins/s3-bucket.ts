import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::S3::Bucket.
 * commonFields contains 6 properties (≤10 as required by AC-6).
 * KMSMasterKeyID uses a showIf conditional on BucketEncryption (AC-8).
 */
export const s3BucketPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,
  commonFields: [
    {
      name: "BucketName",
      question: {
        type: "string",
        label: "Bucket name",
        placeholder: "my-bucket (leave blank for auto-generated)",
      },
    },
    {
      name: "BucketEncryption",
      question: {
        type: "boolean",
        label: "Enable server-side encryption?",
        initialValue: true,
        hint: "SSE-S3 is free. KMS adds ~$1/mo per 10K requests. Recommended for production.",
      },
      toCfn: (answer: unknown) =>
        answer
          ? {
              ServerSideEncryptionConfiguration: [
                { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
              ],
            }
          : undefined,
    },
    {
      name: "KMSMasterKeyID",
      question: {
        type: "string",
        label: "KMS Key ID (leave blank for SSE-S3)",
        placeholder: "arn:aws:kms:...",
        showIf: { field: "BucketEncryption", value: true },
      },
    },
    {
      name: "PublicAccessBlockConfiguration",
      question: {
        type: "boolean",
        label: "Block all public access?",
        initialValue: true,
        hint: "Blocks all public ACLs and policies. Recommended for security.",
      },
      toCfn: (answer: unknown) =>
        answer
          ? {
              BlockPublicAcls: true,
              BlockPublicPolicy: true,
              IgnorePublicAcls: true,
              RestrictPublicBuckets: true,
            }
          : undefined,
    },
    {
      name: "VersioningConfiguration",
      question: {
        type: "boolean",
        label: "Enable versioning?",
        initialValue: false,
        hint: "Keeps all object versions. Increases storage cost. Best for data protection.",
      },
      toCfn: (answer: unknown) => (answer ? { Status: "Enabled" } : undefined),
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
      },
    },
  ],
  advancedFields: [
    // ── Lifecycle ──
    {
      name: "EnableLifecycle",
      question: {
        type: "boolean",
        label: "Add lifecycle rules?",
        initialValue: false,
      },
    },
    {
      name: "LifecycleTransitionDays",
      question: {
        type: "enum",
        label: "Transition to Infrequent Access after (days)",
        options: [
          { value: "30", label: "30 days (recommended)" },
          { value: "60", label: "60 days" },
          { value: "90", label: "90 days" },
          { value: "180", label: "180 days" },
        ],
        initialValue: "30",
        showIf: { field: "EnableLifecycle", value: true },
      },
    },
    {
      name: "LifecycleExpirationDays",
      question: {
        type: "string",
        label: "Expire objects after (days, leave blank for never)",
        placeholder: "365",
        showIf: { field: "EnableLifecycle", value: true },
      },
    },
    // ── CORS ──
    {
      name: "EnableCors",
      question: {
        type: "boolean",
        label: "Enable CORS?",
        initialValue: false,
      },
    },
    {
      name: "CorsAllowedOrigins",
      question: {
        type: "string",
        label: "Allowed origins (comma-separated, * for all)",
        placeholder: "https://example.com, https://app.example.com",
        initialValue: "*",
        showIf: { field: "EnableCors", value: true },
      },
    },
    {
      name: "CorsAllowedMethods",
      question: {
        type: "enum",
        label: "Allowed HTTP methods",
        options: [
          { value: "GET", label: "GET only (read)" },
          { value: "GET,PUT", label: "GET + PUT (read/write)" },
          { value: "GET,PUT,POST,DELETE", label: "All methods" },
        ],
        initialValue: "GET",
        showIf: { field: "EnableCors", value: true },
      },
    },
    // ── Replication ──
    {
      name: "EnableReplication",
      question: {
        type: "boolean",
        label: "Enable cross-region replication?",
        initialValue: false,
        hint: "Requires a destination bucket in another region and an IAM role.",
      },
    },
    {
      name: "ReplicationDestinationBucket",
      question: {
        type: "string",
        label: "Destination bucket ARN",
        placeholder: "arn:aws:s3:::my-replica-bucket",
        showIf: { field: "EnableReplication", value: true },
      },
    },
  ],
  defaults: {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  },
};
