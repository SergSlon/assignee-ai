import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import { KMS_ALIAS_PREFIX } from "../../config/aws-arns.js";
import { isArnOfService } from "../../config/aws-partition.js";
import type { ResourcePlugin } from "../types.js";
import {
  TAGS_VALIDATE,
  TAGS_HINT,
  KMS_ARN_VALIDATION_MSG,
} from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::SSM::Parameter.
 * Supports String, StringList, and SecureString parameter types.
 */
export const ssmParameterPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SSM_PARAMETER,
  commonFields: [
    {
      name: CfnKey.NAME,
      required: true,
      question: {
        type: "string",
        label: "Parameter name",
        placeholder: "/my-app/config/db-host",
        hint: "Must start with /. Use hierarchical paths for organization (e.g., /app/env/key). Max 2048 characters.",
        validate: (value: unknown) => {
          if (!value) return "Parameter name is required";
          const s = String(value);
          if (!s.startsWith("/")) return "Parameter name must start with /";
          if (s.length > 2048)
            return "Parameter name must be 2048 characters or fewer";
          if (!/^\/[a-zA-Z0-9_./-]+$/.test(s))
            return "Parameter name can only contain alphanumeric characters, /, ., -, and _";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.SSM_TYPE,
      required: true,
      question: {
        type: "enum",
        label: "Parameter type",
        options: [
          { value: "String", label: "String — single plain-text value" },
          {
            value: "StringList",
            label: "StringList — comma-separated values",
          },
          {
            value: "SecureString",
            label: "SecureString — encrypted with KMS",
          },
        ],
        initialValue: "String",
        hint: "String for plain config values, StringList for comma-separated lists, SecureString for secrets (encrypted at rest with KMS).",
      },
    },
    {
      name: CfnKey.SSM_VALUE,
      required: true,
      question: {
        type: "string",
        label: "Parameter value",
        placeholder: "my-config-value",
        hint: "The value to store. Max 4096 chars for Standard tier, 8192 for Advanced. SecureString values are encrypted at rest.",
        validate: (value: unknown) => {
          if (!value) return "Parameter value is required";
          if (String(value).length > 8192)
            return "Parameter value must be 8192 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.DESCRIPTION,
      question: {
        type: "string",
        label: FieldLabel.DESCRIPTION,
        placeholder: "Database host for my-app production",
        hint: "Human-readable description of what this parameter stores. Max 1024 characters.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 1024)
            return "Description must be 1024 characters or fewer";
          return undefined;
        },
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
      name: CfnKey.TIER,
      question: {
        type: "enum",
        label: "Parameter tier",
        options: [
          {
            value: AwsDefault.SSM_TIER_STANDARD,
            label: "Standard — free, 4KB max, 10K params limit",
          },
          {
            value: "Advanced",
            label: "Advanced — paid tier, 8KB max, 100K params limit",
          },
        ],
        initialValue: AwsDefault.SSM_TIER_STANDARD,
        hint: "Standard is free (up to 10,000 parameters, 4KB max value). Advanced is a paid tier but allows 8KB values and 100,000 parameters.",
      },
    },
    {
      name: CfnKey.KMS_KEY_ID,
      question: {
        type: "string",
        label: "KMS Key ID",
        placeholder: "arn:aws:kms:...",
        hint: "ARN of a custom KMS key for SecureString encryption. Leave blank to use the default AWS-managed key (aws/ssm).",
        showIf: { field: CfnKey.SSM_TYPE, value: "SecureString" },
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!isArnOfService(s, "kms") && !s.startsWith(KMS_ALIAS_PREFIX))
            return KMS_ARN_VALIDATION_MSG;
          return undefined;
        },
      },
    },
  ],
  defaults: {
    [CfnKey.SSM_TYPE]: "String",
    [CfnKey.TIER]: AwsDefault.SSM_TIER_STANDARD,
  },
  configHints: [
    "Name MUST start with a forward slash (/) and use hierarchical paths (e.g., /app/env/key). This is enforced by AWS — omitting the leading slash causes a CloudFormation error.",
    "Type is immutable — changing between String, StringList, and SecureString triggers resource replacement. SecureString values are encrypted at rest with KMS.",
    "CloudFormation does NOT support creating SecureString parameters — use Type 'String' and store sensitive values in Secrets Manager instead, or manage SecureString parameters outside CloudFormation.",
    "Tier defaults to 'Standard' (free, 4KB max, 10K parameter limit). Only use 'Advanced' if the value exceeds 4KB or you need parameter policies (expiration, notification).",
    "Value is REQUIRED and appears in plaintext in CloudFormation templates and events for String/StringList types — never store secrets as plain String parameters.",
  ],
};
