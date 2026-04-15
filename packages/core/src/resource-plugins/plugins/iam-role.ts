import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import { IamPolicy, AwsServicePrincipal } from "../../config/aws-arns.js";
import { isArnOfService } from "../../config/aws-partition.js";
import { IamEffect } from "../../config/iam-effects.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * Wave 19 Bug #2: recognize a real AssumeRolePolicyDocument emitted by the
 * LLM plan_generator, so we can pass it through unchanged instead of trying
 * to look it up as if it were a 3-enum wizard key. The LLM may emit the
 * policy as either:
 *
 *   1. A parsed JSON OBJECT — `{ Version: "2012-10-17", Statement: [...] }`
 *      (rare; happens when the upstream pipeline already parsed it)
 *   2. A JSON STRING — `'{"Version":"2012-10-17","Statement":[...]}'`
 *      (common; matches what we observed in the 2026-04-08 live smoke logs)
 *
 * Both forms must be accepted. The CFN AssumeRolePolicyDocument property
 * itself is a JSON-typed structure, so handing CCAPI either an object or a
 * pre-stringified JSON works the same way at the CloudFormation level.
 *
 * Returns the parsed/passed-through policy object on success, or null when
 * the input is not a recognizable policy shape (callers fall back to enum
 * lookup).
 */
function tryParseTrustPolicyDocument(value: unknown): object | null {
  // Object shape — pass through unchanged
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const doc = value as { Statement?: unknown };
    if (Array.isArray(doc.Statement) && doc.Statement.length > 0) {
      return value;
    }
    return null;
  }
  // String shape — try parsing as JSON. The leading `{` check is a cheap
  // pre-filter so we don't run JSON.parse on enum keys like "ec2" / "lambda".
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const doc = parsed as { Statement?: unknown };
        if (Array.isArray(doc.Statement) && doc.Statement.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Not valid JSON — fall through to enum lookup
    }
  }
  return null;
}

/** Common trust policies for AWS service principals. */
const TRUST_POLICIES: Record<string, object> = {
  ec2: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.EC2 },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
  lambda: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.LAMBDA },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
  ecs: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.ECS_TASKS },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
};

/**
 * ResourcePlugin for AWS::IAM::Role.
 * Provides enum-based trust policy selection and managed policy attachment.
 * SECURITY: Never creates roles with AdministratorAccess (see AGENTS.md).
 */
export const iamRolePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.IAM_ROLE,
  commonFields: [
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
      toCfn: (answer: unknown) => {
        // Wave 19 Bug #2: accept three shapes.
        //
        // 1. Wizard path: `answer` is a short enum key ("ec2"/"lambda"/"ecs")
        //    and we look it up in TRUST_POLICIES for a pre-built document.
        //
        // 2. LLM-as-object path: the plan_generator hands us a parsed
        //    AssumeRolePolicyDocument JSON object.
        //
        // 3. LLM-as-string path: the plan_generator hands us a JSON string
        //    (this is the common case observed in the 2026-04-08 live
        //    smoke logs — the warning fired with the literal JSON in the
        //    "Unknown trust policy" message because String(stringValue)
        //    just returns the string unchanged).
        //
        // Before this fix, both LLM paths fell through the enum lookup,
        // hit `undefined`, emitted a scary "Unknown trust policy" warning,
        // and then the required-field validator killed the run with
        // "Missing required fields for AWS::IAM::Role". This meant every
        // plain-intent `assignee apply "Create an IAM role ..."` failed
        // unless the user knew the `--set AssumeRolePolicyDocument=ec2`
        // workaround.
        //
        // Pass-through recognizes anything that looks like a valid policy
        // document (object or JSON string with a non-empty Statement array).
        // Invalid strings still emit the warning + drop behavior.
        const llmPolicy = tryParseTrustPolicyDocument(answer);
        if (llmPolicy !== null) {
          return llmPolicy;
        }
        const key = String(answer);
        const policy = TRUST_POLICIES[key];
        if (!policy) {
          process.stderr.write(
            `Warning: Unknown trust policy "${key}". AssumeRolePolicyDocument omitted.\n`,
          );
          return undefined;
        }
        return policy;
      },
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
  ],
  advancedFields: [
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
  ],
  defaults: {
    [CfnKey.MAX_SESSION_DURATION]: 3600,
  },
  configHints: [
    "NEVER attach AdministratorAccess — all roles MUST have a permissions boundary.",
    "Use least-privilege: attach only the specific managed policies needed.",
    "AssumeRolePolicyDocument is REQUIRED — it defines which AWS service (ec2, lambda, ecs) or account can assume the role. Without it the role is unusable.",
    "ManagedPolicyArns is an array of strings — maximum 10 managed policies per role. Exceeding the limit causes a CloudFormation error.",
    "RoleName is immutable — changing it triggers replacement of the role and all resources that reference it.",
    // Wave 19 Bug #8: the LLM was observed hallucinating non-existent AWS
    // managed policy ARNs like `arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforAWSServiceAccess`
    // and `.../AmazonEC2RoleforAWSCodeDeployRole` (both 404 from CCAPI).
    // Constrain it to a verified list. If the user's intent doesn't clearly
    // need a managed policy attachment, OMIT ManagedPolicyArns entirely
    // rather than inventing one — the role will still work via inline
    // policies (PolicyDocument under Policies) or a permissions boundary.
    // Partition note: this list embeds `arn:aws:` (commercial) — LLM
    // callers must rewrite the partition segment to match the target
    // region when planning for GovCloud (`arn:aws-us-gov:`) or China
    // (`arn:aws-cn:`). The managed-policy names themselves are stable
    // across partitions; only the partition literal changes.
    "ManagedPolicyArns: ONLY use ARNs from this verified list of common AWS-managed policies. " +
      "For GovCloud use arn:aws-us-gov:... and for China use arn:aws-cn:... with the same policy names. " +
      "If the user's intent does not clearly require any of these, OMIT ManagedPolicyArns (do NOT invent ARNs). " +
      "Verified list (commercial partition shown — swap `aws` for the target partition): " +
      [
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonS3FullAccess",
        "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess",
        "arn:aws:iam::aws:policy/AmazonSQSReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonSQSFullAccess",
        "arn:aws:iam::aws:policy/AmazonSNSReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
        "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess",
        "arn:aws:iam::aws:policy/CloudWatchFullAccess",
        "arn:aws:iam::aws:policy/CloudWatchLogsReadOnlyAccess",
        "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess",
        "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess",
        "arn:aws:iam::aws:policy/AmazonRDSFullAccess",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaDynamoDBExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AWSLambdaKinesisExecutionRole",
        "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        "arn:aws:iam::aws:policy/PowerUserAccess",
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
      ].join(", "),
  ],
};
