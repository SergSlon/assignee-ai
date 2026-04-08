import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import { ArnPrefix, KMS_ALIAS_PREFIX } from "../../config/aws-arns.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::EFS::FileSystem.
 *
 * commonFields: Name (tag), PerformanceMode, ThroughputMode, Encrypted, Tags.
 * advancedFields: ProvisionedThroughputInMibps (conditional), KmsKeyId,
 *   BackupPolicy.Status, AvailabilityZoneName (One Zone mode).
 *
 * EFS specifics (verified via CCAPI DescribeType on 2026-04-08):
 *   - All properties are optional at the CCAPI layer (no required fields).
 *   - Encrypted, KmsKeyId, PerformanceMode, AvailabilityZoneName are
 *     createOnly — cannot be changed after create.
 *   - FileSystemTags is the tag key (not Tags).
 *   - ThroughputMode: "bursting" | "provisioned" | "elastic".
 *     ProvisionedThroughputInMibps is required only when
 *     ThroughputMode === "provisioned".
 *   - BackupPolicy is a nested { Status: "ENABLED" | "DISABLED" } object.
 *
 * Security defaults (BP-EFS-001 / BP-EFS-002):
 *   - Encrypted defaults to true.
 *   - BackupPolicy.Status defaults to ENABLED.
 *
 * @see A1 sprint slice — first-class EFS support (2026-04-08)
 */
export const efsFileSystemPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
  commonFields: [
    {
      name: CfnKey.NAME,
      required: true,
      question: {
        type: "string",
        label: "File system name",
        placeholder: "my-shared-volume",
        hint: "Used as the Name tag on the file system. Does not change the AWS resource ID. Max 256 characters.",
        validate: (value: unknown) => {
          if (!value) return "File system name is required";
          const s = String(value);
          if (s.length > 256)
            return "File system name must be 256 characters or fewer";
          if (!/^[\w .:/=+@-]+$/.test(s))
            return "File system name may only contain letters, numbers, spaces, and the characters: _ . : / = + @ -";
          return undefined;
        },
      },
      // toCfn: promote the Name into FileSystemTags (EFS has no FileSystemName
      // property — naming is done via the Name tag).
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return [{ Key: "Name", Value: answer.trim() }];
      },
    },
    {
      name: CfnKey.PERFORMANCE_MODE,
      question: {
        type: "enum",
        label: "Performance mode",
        options: [
          {
            value: AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
            label: "General Purpose",
            recommended: true,
            fitHint:
              "Best for latency-sensitive workloads like web serving, content management, and home directories (default)",
          },
          {
            value: AwsDefault.EFS_PERFORMANCE_MAX_IO,
            label: "Max I/O",
            fitHint:
              "Higher throughput but higher latency per operation — only for big data, media processing, or analytics",
          },
        ],
        initialValue: AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
        hint: "Cannot be changed after the file system is created. General Purpose is recommended for almost all workloads.",
      },
    },
    {
      name: CfnKey.THROUGHPUT_MODE,
      question: {
        type: "enum",
        label: "Throughput mode",
        options: [
          {
            value: AwsDefault.EFS_THROUGHPUT_ELASTIC,
            label: "Elastic (pay-per-use, recommended)",
            recommended: true,
            fitHint:
              "Automatically scales throughput up and down based on workload. Best for spiky or unpredictable traffic.",
          },
          {
            value: AwsDefault.EFS_THROUGHPUT_BURSTING,
            label: "Bursting (default, credits-based)",
            fitHint:
              "Throughput scales with file system size. Free credits build up during idle periods. Good for traditional workloads.",
          },
          {
            value: AwsDefault.EFS_THROUGHPUT_PROVISIONED,
            label: "Provisioned (fixed MiB/s)",
            fitHint:
              "You pay for a fixed throughput level regardless of size. Use only when you need guaranteed throughput > 2x burst.",
          },
        ],
        initialValue: AwsDefault.EFS_THROUGHPUT_ELASTIC,
        hint: "Elastic is the modern default for unpredictable workloads and is billed per-GB read/written. Bursting is free but throughput is tied to size. Provisioned is expensive — only use when required.",
      },
    },
    {
      name: CfnKey.ENCRYPTED,
      question: {
        type: "boolean",
        label: "Encrypt at rest?",
        initialValue: true,
        hint: "AWS strongly recommends encryption at rest. Uses the default AWS-managed key (aws/elasticfilesystem) unless a customer-managed KMS key is provided in advanced options. Cannot be changed after creation.",
      },
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
      name: CfnKey.PROVISIONED_THROUGHPUT_IN_MIBPS,
      question: {
        type: "string",
        label: "Provisioned throughput (MiB/s)",
        placeholder: "100",
        initialValue: "100",
        hint: "Throughput in mebibytes per second. Only applies when ThroughputMode=provisioned. Minimum 1 MiB/s, maximum 3072 MiB/s. Billed per MiB/s-hour.",
        showIf: {
          field: CfnKey.THROUGHPUT_MODE,
          value: AwsDefault.EFS_THROUGHPUT_PROVISIONED,
        },
        validate: (value: unknown) => {
          if (!value)
            return "ProvisionedThroughputInMibps required when ThroughputMode=provisioned";
          const n = Number(value);
          if (!Number.isFinite(n) || n < 1 || n > 3072)
            return "Must be a number between 1 and 3072";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (answer === undefined || answer === "" || answer === null)
          return undefined;
        const n = Number(answer);
        return Number.isFinite(n) ? n : undefined;
      },
    },
    {
      name: CfnKey.KMS_KEY_ID,
      question: {
        type: "string",
        label: "KMS Key ID, ARN, or alias (customer-managed)",
        placeholder: "arn:aws:kms:... or alias/my-key",
        initialValue: "",
        hint: "Optional. Leave blank to use the AWS-managed key (aws/elasticfilesystem, free). Specify a customer-managed KMS key for full rotation/audit/cross-account control. Only applies when Encrypted=true. Cannot be changed after creation.",
        showIf: { field: CfnKey.ENCRYPTED, value: true },
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (
            s.startsWith(ArnPrefix.KMS) ||
            s.startsWith(KMS_ALIAS_PREFIX) ||
            /^[a-f0-9-]{36}$/i.test(s)
          )
            return undefined;
          return "Must be a KMS key ARN, alias (alias/...), or 36-character key ID";
        },
      },
    },
    {
      name: CfnKey.BACKUP_POLICY,
      question: {
        type: "boolean",
        label: "Enable automatic backups? (BP-EFS-002)",
        initialValue: true,
        hint: "Recommended for production. Backups are managed by AWS Backup and billed separately (~$0.05/GB-mo for warm storage). Disabling this triggers the BP-EFS-002 best practice warning.",
      },
      toCfn: (answer: unknown) =>
        answer
          ? { Status: AwsDefault.EFS_BACKUP_ENABLED }
          : { Status: AwsDefault.EFS_BACKUP_DISABLED },
    },
    {
      name: CfnKey.AVAILABILITY_ZONE_NAME,
      question: {
        type: "string",
        label: "Availability Zone (One Zone mode)",
        placeholder: "us-east-1a",
        initialValue: "",
        hint: "Optional. If set, creates a One Zone file system in the specified AZ (lower cost, lower durability). Leave blank for the default Regional (Multi-AZ) file system. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          if (!/^[a-z]{2}(-gov)?-[a-z]+-\d[a-z]$/.test(s))
            return `Invalid AZ format "${s}" — expected format like us-east-1a`;
          return undefined;
        },
      },
    },
  ],
  defaults: {
    [CfnKey.ENCRYPTED]: true,
    [CfnKey.PERFORMANCE_MODE]: AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
    [CfnKey.THROUGHPUT_MODE]: AwsDefault.EFS_THROUGHPUT_ELASTIC,
    [CfnKey.BACKUP_POLICY]: {
      [CfnKey.BACKUP_POLICY_STATUS]: AwsDefault.EFS_BACKUP_ENABLED,
    },
  },
  configHints: [
    "EFS has NO FileSystemName property — to name a file system, add a Name key to the FileSystemTags array, not a top-level property.",
    "The Tags array on AWS::EFS::FileSystem is called FileSystemTags, not Tags. Do NOT emit a top-level Tags property.",
    "Encrypted defaults to true and should only be set to false on explicit user request — even then, warn that BP-EFS-001 will block.",
    "ThroughputMode 'elastic' is the modern default; 'bursting' is the legacy default. Do not set ProvisionedThroughputInMibps unless ThroughputMode is 'provisioned'.",
    "BackupPolicy is a nested object — emit { BackupPolicy: { Status: 'ENABLED' } }, never a top-level Status.",
    "PerformanceMode, Encrypted, KmsKeyId, and AvailabilityZoneName are createOnly in the CCAPI schema — any attempt to update them triggers a replace.",
  ],
};
