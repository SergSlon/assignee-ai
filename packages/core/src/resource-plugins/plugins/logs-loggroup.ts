import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/**
 * ResourcePlugin for AWS::Logs::LogGroup.
 * commonFields contains 4 properties (≤10 as required).
 * RetentionInDays defaults to 14 (best practice: never leave infinite).
 */
export const logGroupPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
  commonFields: [
    {
      name: "LogGroupName",
      question: {
        type: "string",
        label: "Log group name",
        placeholder: "/aws/lambda/my-function",
        hint: "Follows AWS conventions: /aws/lambda/<function-name> for Lambda, /aws/ecs/<cluster>/<service> for ECS, or any custom string up to 512 characters. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional (auto-generated)
          const s = String(value);
          if (s.length > 512)
            return "Log group name must be 512 characters or fewer";
          if (!/^[a-zA-Z0-9_./#-]+$/.test(s))
            return "Log group name can only contain alphanumeric characters, underscores, hyphens, slashes, hash signs, and periods";
          return undefined;
        },
      },
    },
    {
      name: "RetentionInDays",
      question: {
        type: "enum",
        label: "Log retention period",
        options: [
          { value: "1", label: "1 day" },
          { value: "3", label: "3 days" },
          { value: "5", label: "5 days" },
          { value: "7", label: "7 days" },
          { value: "14", label: "14 days (recommended)", recommended: true },
          { value: "30", label: "30 days" },
          { value: "60", label: "60 days" },
          { value: "90", label: "90 days" },
          { value: "120", label: "120 days" },
          { value: "150", label: "150 days" },
          { value: "180", label: "180 days" },
          { value: "365", label: "365 days (1 year)" },
          { value: "400", label: "400 days" },
          { value: "545", label: "545 days (18 months)" },
          { value: "731", label: "731 days (2 years)" },
          { value: "1096", label: "1096 days (3 years)" },
          { value: "1827", label: "1827 days (5 years)" },
          { value: "2192", label: "2192 days (6 years)" },
          { value: "2557", label: "2557 days (7 years)" },
          { value: "2922", label: "2922 days (8 years)" },
          { value: "3653", label: "3653 days (10 years)" },
          { value: "never", label: "Never expire (not recommended)" },
        ],
        initialValue: "14",
        hint: "How long to keep log data. Longer retention increases storage costs. 14 days is recommended for development, 90-365 days for production. 'Never expire' is discouraged — it leads to unbounded storage costs.",
      },
      toCfn: (answer: unknown) => {
        if (answer === "never" || answer === undefined) return undefined;
        return Number(answer);
      },
    },
    {
      name: "KmsKeyId",
      question: {
        type: "string",
        label: "KMS Key ARN for encryption (optional)",
        placeholder: "arn:aws:kms:us-east-1:123456789012:key/...",
        hint: "ARN of a KMS key to encrypt log data at rest. CloudWatch Logs encrypts data by default with AWS-managed keys, but a customer-managed KMS key gives you control over key rotation and access policies. Recommended for production environments with sensitive data.",
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
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization. Example: Environment:production, Team:backend, Project:api. Tags are free and highly recommended.",
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
      name: "LogGroupClass",
      question: {
        type: "enum",
        label: "Log group class",
        options: [
          {
            value: "STANDARD",
            label: "Standard (full features)",
            recommended: true,
          },
          {
            value: "INFREQUENT_ACCESS",
            label: "Infrequent Access (lower cost, limited features)",
            costHint: "~50% cheaper ingestion",
          },
        ],
        initialValue: "STANDARD",
        hint: "STANDARD supports all CloudWatch Logs features. INFREQUENT_ACCESS has lower ingestion cost but does not support live tail, metric filters, or subscription filters. Cannot be changed after creation.",
      },
    },
    {
      name: "DataProtectionPolicy",
      question: {
        type: "string",
        label: "Data protection policy (JSON)",
        placeholder: '{"Name": "data-protection-policy", ...}',
        hint: "JSON-formatted data protection policy to mask sensitive data (PII, credentials) in log events. AWS provides managed data identifiers for common patterns like SSNs, credit card numbers, and email addresses.",
      },
    },
  ],
  defaults: {
    RetentionInDays: 14,
    LogGroupClass: "STANDARD",
  },
  configHints: [
    "LogGroupName follows AWS naming conventions: /aws/lambda/<function-name> for Lambda, /aws/ecs/<cluster>/<service> for ECS.",
    "RetentionInDays MUST be set — never leave as infinite to avoid unbounded storage costs.",
    "KmsKeyId is recommended for production environments with sensitive log data.",
    "LogGroupClass cannot be changed after creation — STANDARD is the safe default.",
  ],
};
