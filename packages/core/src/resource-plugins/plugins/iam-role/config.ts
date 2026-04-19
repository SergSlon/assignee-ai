import { CfnKey } from "@/config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";

export const defaults: ResourcePlugin["defaults"] = {
  [CfnKey.MAX_SESSION_DURATION]: 3600,
};

/**
 * Partition note: this list embeds `arn:aws:` (commercial) — LLM callers
 * must rewrite the partition segment for GovCloud (`arn:aws-us-gov:`) or
 * China (`arn:aws-cn:`). The managed-policy names themselves are stable
 * across partitions; only the partition literal changes.
 */
const VERIFIED_MANAGED_POLICY_ARNS = [
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
];

export const configHints: ResourcePlugin["configHints"] = [
  "NEVER attach AdministratorAccess — all roles MUST have a permissions boundary.",
  "Use least-privilege: attach only the specific managed policies needed.",
  "AssumeRolePolicyDocument is REQUIRED — it defines which AWS service (ec2, lambda, ecs) or account can assume the role. Without it the role is unusable.",
  "ManagedPolicyArns is an array of strings — maximum 10 managed policies per role. Exceeding the limit causes a CloudFormation error.",
  "RoleName is immutable — changing it triggers replacement of the role and all resources that reference it.",
  // Wave 19 Bug #8: the LLM was observed hallucinating non-existent AWS
  // managed policy ARNs (both 404 from CCAPI). Constrain it to a verified
  // list. If the user's intent doesn't clearly need a managed policy
  // attachment, OMIT ManagedPolicyArns entirely rather than inventing one.
  "ManagedPolicyArns: ONLY use ARNs from this verified list of common AWS-managed policies. " +
    "For GovCloud use arn:aws-us-gov:... and for China use arn:aws-cn:... with the same policy names. " +
    "If the user's intent does not clearly require any of these, OMIT ManagedPolicyArns (do NOT invent ARNs). " +
    "Verified list (commercial partition shown — swap `aws` for the target partition): " +
    VERIFIED_MANAGED_POLICY_ARNS.join(", "),
];
