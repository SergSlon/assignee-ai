import { CfnKey } from "../../../config/cfn-keys.js";
import { isArnOfService } from "../../../config/aws-partition.js";
import type { ResourcePlugin } from "../../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../../shared-fields.js";
import { FieldLabel } from "../../field-labels.js";
import { assumeRolePolicyToCfn } from "./trust-policy.js";

export const commonFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.ROLE_NAME,
    question: {
      type: "string",
      label: "Role name",
      placeholder: "my-app-role",
      hint: "Must be 1-64 chars. Use descriptive names like 'my-app-lambda-role'. Leave blank for auto-generated.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (s.length > 64) return "Role name must be 1-64 characters";
        if (!/^[a-zA-Z0-9+=,.@_-]+$/.test(s))
          return "Role name can only contain alphanumeric characters and +=,.@_-";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.DESCRIPTION,
    question: {
      type: "string",
      label: FieldLabel.DESCRIPTION,
      placeholder: "Execution role for my Lambda function",
      hint: "Human-readable description of the role's purpose. Max 1000 characters.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        if (String(value).length > 1000)
          return "Description must be 1000 characters or fewer";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.ASSUME_ROLE_POLICY,
    required: true,
    question: {
      type: "enum",
      label: "Trust policy (which service can assume this role?)",
      options: [
        { value: "ec2", label: "EC2 — for instance profiles" },
        { value: "lambda", label: "Lambda — for function execution" },
        { value: "ecs", label: "ECS — for task execution" },
      ],
      hint: "Determines which AWS service can assume this role. Choose based on where the role will be used.",
    },
    // Wave 19 Bug #2: accepts three shapes — wizard enum key, LLM-as-object,
    // LLM-as-JSON-string. See trust-policy.ts for the full rationale.
    toCfn: assumeRolePolicyToCfn,
  },
  {
    name: CfnKey.MAX_SESSION_DURATION,
    question: {
      type: "enum",
      label: "Maximum session duration",
      options: [
        { value: "3600", label: "1 hour (default)" },
        { value: "7200", label: "2 hours" },
        { value: "14400", label: "4 hours" },
        { value: "28800", label: "8 hours" },
        { value: "43200", label: "12 hours (maximum)" },
      ],
      initialValue: "3600",
      hint: "Maximum time a session can last when assuming this role. Longer sessions are convenient but less secure.",
    },
    toCfn: (answer: unknown) => (answer ? Number(answer) : 3600),
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
  {
    name: CfnKey.PERMISSIONS_BOUNDARY,
    question: {
      type: "string",
      label: "Permissions boundary ARN",
      placeholder: "arn:aws:iam::123456789012:policy/boundary",
      hint: "ARN of a managed policy to use as a permissions boundary. Limits the maximum permissions the role can have. Roles without a permissions boundary violate security policy (see AGENTS.md).",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (!isArnOfService(s, "iam")) return "Must be an IAM policy ARN";
        return undefined;
      },
    },
  },
];

export const advancedFields: ResourcePlugin["advancedFields"] = [
  {
    name: CfnKey.MANAGED_POLICY_ARNS,
    question: {
      type: "string",
      label: "Managed policy ARNs (comma-separated)",
      placeholder: "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
      hint: "Comma-separated ARNs of AWS-managed or customer-managed policies to attach. Max 10 policies per role.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const arns = String(value)
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        for (const arn of arns) {
          if (!isArnOfService(arn, "iam")) return `Invalid ARN: ${arn}`;
          if (arn.includes("AdministratorAccess"))
            return "AdministratorAccess policy is not allowed. Use least-privilege policies instead.";
        }
        if (arns.length > 10) return "Maximum 10 managed policies per role";
        return undefined;
      },
    },
    toCfn: (answer: unknown) => {
      if (typeof answer !== "string" || !answer.trim()) return undefined;
      return answer
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
    },
  },
];
