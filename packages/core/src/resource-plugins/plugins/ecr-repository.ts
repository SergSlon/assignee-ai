import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::ECR::Repository.
 * Container image registry with scanning, encryption, and lifecycle management.
 */
export const ecrRepositoryPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
  commonFields: [
    {
      name: "RepositoryName",
      required: true,
      question: {
        type: "string",
        label: "Repository name",
        placeholder: "my-app",
        hint: "Must be 2-256 chars: lowercase letters, numbers, hyphens, underscores, forward slashes. Namespacing with slashes is common (e.g., team/app).",
        validate: (value: unknown) => {
          if (!value) return "Repository name is required";
          const s = String(value);
          if (s.length < 2 || s.length > 256)
            return "Repository name must be 2-256 characters";
          if (!/^[a-z0-9][a-z0-9._/-]*$/.test(s))
            return "Must start with lowercase letter/number and contain only lowercase letters, numbers, hyphens, underscores, forward slashes, and periods";
          return undefined;
        },
      },
    },
    {
      name: "ImageTagMutability",
      question: {
        type: "enum",
        label: "Image tag mutability",
        options: [
          {
            value: "IMMUTABLE",
            label: "Immutable (recommended)",
            recommended: true,
            fitHint: "Prevents tag overwrites for reproducible deployments",
          },
          {
            value: "MUTABLE",
            label: "Mutable (allows tag overwrites)",
            fitHint: "Allows pushing to the same tag (e.g., latest)",
          },
        ],
        initialValue: "IMMUTABLE",
        hint: "Immutable tags prevent overwriting images, ensuring deployment reproducibility. Mutable allows pushing to 'latest' or re-tagging.",
      },
    },
    {
      name: "ScanOnPush",
      question: {
        type: "boolean",
        label: "Scan images on push?",
        initialValue: true,
        hint: "Automatically scans images for OS vulnerabilities when pushed. Free for basic scanning. Recommended for security compliance.",
      },
      toCfn: (answer: unknown) => ({ ScanOnPush: Boolean(answer) }),
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [
    {
      name: "EncryptionType",
      question: {
        type: "enum",
        label: "Encryption type",
        options: [
          {
            value: "AES256",
            label: "AES-256 (default, free)",
            recommended: true,
          },
          {
            value: "KMS",
            label: "KMS (customer-managed key)",
            costHint: "Additional KMS key and API charges apply",
          },
        ],
        initialValue: "AES256",
        hint: "AES-256 is free and sufficient for most workloads. KMS provides key rotation and audit trails via CloudTrail.",
      },
    },
    {
      name: "KmsKey",
      question: {
        type: "string",
        label: "KMS Key ARN",
        placeholder: "arn:aws:kms:us-east-1:123456789012:key/...",
        hint: "ARN of the KMS key for encryption. Required when EncryptionType is KMS.",
        showIf: { field: "EncryptionType", value: "KMS" },
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!s.startsWith("arn:aws:kms:"))
            return "Must be a KMS key ARN (arn:aws:kms:...)";
          return undefined;
        },
      },
    },
    {
      name: "LifecyclePolicyText",
      question: {
        type: "string",
        label: "Lifecycle policy (JSON)",
        placeholder: '{"rules":[{"rulePriority":1,...}]}',
        hint: "JSON lifecycle policy to automatically clean up old/untagged images. Reduces storage costs. Leave blank for no lifecycle policy.",
      },
    },
  ],
  defaults: {
    ImageTagMutability: "IMMUTABLE",
    ImageScanningConfiguration: { ScanOnPush: true },
  },
};
