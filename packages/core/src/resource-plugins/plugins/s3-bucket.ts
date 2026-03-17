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
      },
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
      },
    },
    {
      name: "VersioningConfiguration",
      question: {
        type: "boolean",
        label: "Enable versioning?",
        initialValue: false,
      },
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
    {
      name: "LifecycleConfiguration",
      question: {
        type: "boolean",
        label: "Add lifecycle rules?",
        initialValue: false,
      },
    },
    {
      name: "CorsConfiguration",
      question: {
        type: "boolean",
        label: "Enable CORS?",
        initialValue: false,
      },
    },
    {
      name: "ReplicationConfiguration",
      question: {
        type: "boolean",
        label: "Enable cross-region replication?",
        initialValue: false,
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
