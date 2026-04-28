import { randomBytes } from "node:crypto";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import { isArnOfService } from "../../config/aws-partition.js";
import type { ResourcePlugin } from "../types.js";
import {
  TAGS_VALIDATE,
  TAGS_HINT,
  KMS_ARN_FULL_VALIDATION_MSG,
} from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * Epic 92 Wave 4.b (finding C-22): plans omitted RepositoryName when the
 * user didn't specify one, leaving the operator with no idea what will be
 * created. Mirrors the Lambda compound pattern's `assignee-lambda-fn-<hash>`:
 *
 *   assignee-ecr-repository-<8 hex>
 *
 * ECR RepositoryName constraints: 2-256 chars, `[a-z0-9][a-z0-9._/-]*`.
 * 8 lowercase hex chars fit trivially. Destroy round-trip preserved.
 */
const PLACEHOLDER_ECR_NAMES = new Set([
  "my-app",
  "my-ecr",
  "my-ecr-repo",
  "my-repository",
  "example-repo",
  "example-repository",
  "example-ecr-repository",
]);

function generateEcrRepositoryName(): string {
  return `assignee-ecr-repository-${randomBytes(4).toString("hex")}`;
}

/**
 * ResourcePlugin for AWS::ECR::Repository.
 * Container image registry with scanning, encryption, and lifecycle management.
 */
export const ecrRepositoryPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
  commonFields: [
    {
      name: CfnKey.REPOSITORY_NAME,
      required: true,
      question: {
        type: "string",
        label: "Repository name",
        placeholder:
          "assignee-ecr-repository-<8hex> (leave blank for auto-generated)",
        hint: "Must be 2-256 chars: lowercase letters, numbers, hyphens, underscores, forward slashes. Namespacing with slashes is common (e.g., team/app). Leave blank — Assignee auto-generates 'assignee-ecr-repository-<8hex>'.",
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
      toCfn: (v: unknown) => {
        if (v === undefined || v === null) return generateEcrRepositoryName();
        const s = String(v).trim();
        if (s === "") return generateEcrRepositoryName();
        if (PLACEHOLDER_ECR_NAMES.has(s.toLowerCase())) {
          return generateEcrRepositoryName();
        }
        return s;
      },
    },
    {
      name: CfnKey.IMAGE_TAG_MUTABILITY,
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
      name: CfnKey.SCAN_ON_PUSH,
      question: {
        type: "boolean",
        label: "Scan images on push?",
        initialValue: true,
        hint: "Automatically scans images for OS vulnerabilities when pushed. Free for basic scanning. Recommended for security compliance.",
      },
      toCfn: (answer: unknown) => ({ [CfnKey.SCAN_ON_PUSH]: Boolean(answer) }),
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:backend",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: CfnKey.ENCRYPTION_TYPE,
      question: {
        type: "enum",
        label: "Encryption type",
        options: [
          {
            value: AwsDefault.ENCRYPTION_AES256,
            label: "AES-256 (default, free)",
            recommended: true,
          },
          {
            value: "KMS",
            label: "KMS (customer-managed key)",
            costHint: "Additional KMS key and API charges apply",
          },
        ],
        initialValue: AwsDefault.ENCRYPTION_AES256,
        hint: "AES-256 is free and sufficient for most workloads. KMS provides key rotation and audit trails via CloudTrail.",
      },
    },
    {
      name: CfnKey.KMS_KEY,
      question: {
        type: "enum",
        label: "KMS Key ARN",
        placeholder: "arn:aws:kms:us-east-1:<your-12-digit-account-id>:key/...",
        hint: "ARN of the KMS key for encryption. Required when EncryptionType is KMS.",
        showIf: { field: CfnKey.ENCRYPTION_TYPE, value: "KMS" },
        fetcher: "discover-kms-keys",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!isArnOfService(s, "kms")) return KMS_ARN_FULL_VALIDATION_MSG;
          return undefined;
        },
      },
    },
    {
      name: CfnKey.LIFECYCLE_POLICY_TEXT,
      question: {
        type: "string",
        label: "Lifecycle policy (JSON)",
        placeholder: '{"rules":[{"rulePriority":1,...}]}',
        hint: "JSON lifecycle policy to automatically clean up old/untagged images. Reduces storage costs. Leave blank for no lifecycle policy.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          if (!s) return undefined;
          try {
            JSON.parse(s);
          } catch {
            return "Must be valid JSON";
          }
          return undefined;
        },
      },
    },
  ],
  defaults: {
    [CfnKey.IMAGE_TAG_MUTABILITY]: "IMMUTABLE",
    [CfnKey.IMAGE_SCANNING_CONFIGURATION]: { [CfnKey.SCAN_ON_PUSH]: true },
    get [CfnKey.REPOSITORY_NAME](): string {
      return generateEcrRepositoryName();
    },
  },
  configHints: [
    "ALWAYS set ImageTagMutability to IMMUTABLE unless the user explicitly needs mutable tags (e.g., for 'latest' tag workflows). Immutable tags prevent accidental overwrites.",
    "ImageScanningConfiguration.ScanOnPush should be true for security compliance — it scans for OS vulnerabilities at no extra cost (basic scanning).",
    "EncryptionConfiguration.EncryptionType defaults to AES256 (free). Only use KMS if the user needs customer-managed key rotation or cross-account access control.",
    "LifecyclePolicy is a JSON string (not an object) — it MUST be passed as the LifecyclePolicyText property. Common rule: expire untagged images after 14 days to control storage costs.",
    "RepositoryName is immutable — changing it triggers resource replacement. Use lowercase letters, numbers, hyphens, underscores, and forward slashes only.",
    "RepositoryName: OMIT when the user didn't specify a name. Assignee auto-generates `assignee-ecr-repository-<8hex>` so placeholders like `my-app`, `my-ecr-repo`, or `example-repository` never materialize in production.",
  ],
};
