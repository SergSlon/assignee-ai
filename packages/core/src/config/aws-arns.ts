/**
 * AWS ARN constants and managed policy ARNs — single source of truth.
 *
 * Validators (`startsWith(ArnPrefix.X)` pattern) were REMOVED in Wave 4
 * because they silently rejected GovCloud, China, and ISO ARNs. All
 * service-segment checks now go through the partition-aware
 * `isArnOfService(value, "iam")` helper in `aws-partition.ts`.
 *
 * @see feedback_partition_aware_arn_matching (operator memory)
 */

/** KMS key alias prefix */
export const KMS_ALIAS_PREFIX = "alias/" as const;

/**
 * AWS-managed policy path suffixes — the portion of the ARN after
 * `arn:<partition>:iam::aws:policy/`. Use with `awsManagedPolicyArn()`
 * to build partition-correct ARNs at runtime.
 *
 * @example
 *   awsManagedPolicyArn("aws-us-gov", AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH)
 *   // → "arn:aws-us-gov:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
 */
export const AwsManagedPolicy = {
  /** Path suffix for AWSLambdaBasicExecutionRole. */
  LAMBDA_BASIC_EXECUTION_PATH:
    "service-role/AWSLambdaBasicExecutionRole" as const,
  /** Path suffix for PowerUserAccess. */
  POWER_USER_ACCESS_PATH: "PowerUserAccess" as const,
} as const;

/**
 * Builds a partition-aware AWS-managed policy ARN.
 *
 * Validates that `partition` conforms to the AWS partition naming scheme:
 * starts with `aws` optionally followed by one or more `-<lowercase>` segments.
 * Throws `RangeError` for unrecognised partition strings.
 *
 * @param partition - AWS partition: `aws` | `aws-us-gov` | `aws-cn` | `aws-iso` | `aws-iso-b` (etc.)
 * @param policyPath - Path suffix after `policy/`, e.g. `"service-role/AWSLambdaBasicExecutionRole"`
 *
 * @example
 *   awsManagedPolicyArn("aws", AwsManagedPolicy.POWER_USER_ACCESS_PATH)
 *     // → "arn:aws:iam::aws:policy/PowerUserAccess"
 *   awsManagedPolicyArn("aws-us-gov", AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH)
 *     // → "arn:aws-us-gov:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
 *
 * @see feedback_partition_aware_arn_matching (operator memory) — never use literal `"arn:aws:"`.
 */
export function awsManagedPolicyArn(
  partition: string,
  policyPath: string,
): string {
  // Must match AWS partition format: "aws" optionally followed by "-<lowercase-letters>" segments.
  if (!/^aws(?:-[a-z]+)*$/.test(partition)) {
    throw new RangeError(
      `awsManagedPolicyArn: unrecognised partition "${partition}". ` +
        `Expected one of: aws, aws-us-gov, aws-cn, aws-iso, aws-iso-b (or other aws-* partitions).`,
    );
  }
  return `arn:${partition}:iam::aws:policy/${policyPath}`;
}

/**
 * Default Bedrock foundation model ARN wildcard for IAM policies. The
 * partition segment is `*` so the wildcard matches across commercial,
 * GovCloud, China, and ISO partitions — IAM accepts `*` in the
 * partition segment of Resource ARNs.
 */
export const BEDROCK_MODEL_ARN_WILDCARD =
  "arn:*:bedrock:*::foundation-model/*" as const;

/** IAM policy document constants. */
export const IamPolicy = {
  VERSION: "2012-10-17",
  ACTION_ASSUME_ROLE: "sts:AssumeRole",
} as const;

/** Common IAM action strings used across policy definitions. */
export const IamAction = {
  // Bedrock
  BEDROCK_INVOKE: "bedrock:InvokeModel",
  BEDROCK_INVOKE_STREAM: "bedrock:InvokeModelWithResponseStream",
  // CloudFormation
  CFN_DESCRIBE_TYPE: "cloudformation:DescribeType",
  CFN_LIST_TYPES: "cloudformation:ListTypes",
  // SSM
  SSM_GET_PARAMETER: "ssm:GetParameter",
  // EC2 Discovery
  EC2_DESCRIBE_INSTANCES: "ec2:DescribeInstances",
  EC2_DESCRIBE_SUBNETS: "ec2:DescribeSubnets",
  EC2_DESCRIBE_SECURITY_GROUPS: "ec2:DescribeSecurityGroups",
  EC2_DESCRIBE_KEY_PAIRS: "ec2:DescribeKeyPairs",
  EC2_CREATE_KEY_PAIR: "ec2:CreateKeyPair",
  EC2_DELETE_KEY_PAIR: "ec2:DeleteKeyPair",
  EC2_DESCRIBE_INSTANCE_TYPES: "ec2:DescribeInstanceTypes",
  EC2_DESCRIBE_IMAGES: "ec2:DescribeImages",
  // RDS Discovery
  RDS_DESCRIBE_DB_ENGINE_VERSIONS: "rds:DescribeDBEngineVersions",
  RDS_DESCRIBE_ORDERABLE_INSTANCES: "rds:DescribeOrderableDBInstanceOptions",
  // Pricing
  PRICING_GET_PRODUCTS: "pricing:GetProducts",
  PRICING_DESCRIBE_SERVICES: "pricing:DescribeServices",
  PRICING_GET_ATTRIBUTE_VALUES: "pricing:GetAttributeValues",
  // Cost Explorer
  CE_GET_COST_AND_USAGE: "ce:GetCostAndUsage",
  CE_GET_COST_FORECAST: "ce:GetCostForecast",
  // IAM
  IAM_SIMULATE_CUSTOM_POLICY: "iam:SimulateCustomPolicy",
  IAM_SIMULATE_PRINCIPAL_POLICY: "iam:SimulatePrincipalPolicy",
  IAM_GET_USER: "iam:GetUser",
  IAM_GET_ROLE: "iam:GetRole",
  IAM_GET_POLICY: "iam:GetPolicy",
  IAM_GET_POLICY_VERSION: "iam:GetPolicyVersion",
  IAM_GET_USER_POLICY: "iam:GetUserPolicy",
  IAM_GET_ROLE_POLICY: "iam:GetRolePolicy",
  IAM_LIST_USERS: "iam:ListUsers",
  IAM_LIST_ROLES: "iam:ListRoles",
  IAM_LIST_POLICIES: "iam:ListPolicies",
  IAM_LIST_USER_POLICIES: "iam:ListUserPolicies",
  IAM_LIST_ROLE_POLICIES: "iam:ListRolePolicies",
  IAM_LIST_ATTACHED_USER_POLICIES: "iam:ListAttachedUserPolicies",
  IAM_LIST_ATTACHED_ROLE_POLICIES: "iam:ListAttachedRolePolicies",
  // SecurityHub
  SECURITYHUB_GET_FINDINGS: "securityhub:GetFindings",
  SECURITYHUB_GET_INSIGHTS: "securityhub:GetInsights",
  SECURITYHUB_GET_ENABLED_STANDARDS: "securityhub:GetEnabledStandards",
  SECURITYHUB_LIST_FINDINGS: "securityhub:ListFindings",
  SECURITYHUB_LIST_ENABLED_PRODUCTS: "securityhub:ListEnabledProductsForImport",
  SECURITYHUB_DESCRIBE_HUB: "securityhub:DescribeHub",
  SECURITYHUB_DESCRIBE_STANDARDS: "securityhub:DescribeStandards",
  SECURITYHUB_DESCRIBE_STANDARDS_CONTROLS:
    "securityhub:DescribeStandardsControls",
  SECURITYHUB_BATCH_GET_FINDINGS: "securityhub:BatchGetFindings",
  // GuardDuty
  GUARDDUTY_GET_DETECTOR: "guardduty:GetDetector",
  GUARDDUTY_GET_FINDINGS: "guardduty:GetFindings",
  GUARDDUTY_LIST_DETECTORS: "guardduty:ListDetectors",
  GUARDDUTY_LIST_FINDINGS: "guardduty:ListFindings",
  // Inspector
  INSPECTOR_LIST_FINDINGS: "inspector2:ListFindings",
  INSPECTOR_GET_FINDINGS_REPORT_STATUS: "inspector2:GetFindingsReportStatus",
  INSPECTOR_LIST_COVERAGE: "inspector2:ListCoverage",
  // Access Analyzer
  ACCESS_ANALYZER_GET_ANALYZER: "access-analyzer:GetAnalyzer",
  ACCESS_ANALYZER_LIST_ANALYZERS: "access-analyzer:ListAnalyzers",
  ACCESS_ANALYZER_LIST_FINDINGS: "access-analyzer:ListFindings",
  ACCESS_ANALYZER_GET_FINDING: "access-analyzer:GetFinding",
  // CloudWatch Logs
  LOGS_CREATE_LOG_GROUP: "logs:CreateLogGroup",
  LOGS_CREATE_LOG_STREAM: "logs:CreateLogStream",
  LOGS_PUT_LOG_EVENTS: "logs:PutLogEvents",
  LOGS_DESCRIBE_LOG_GROUPS: "logs:DescribeLogGroups",
  LOGS_PUT_RETENTION_POLICY: "logs:PutRetentionPolicy",
  LOGS_DELETE_LOG_GROUP: "logs:DeleteLogGroup",
  LOGS_TAG_LOG_GROUP: "logs:TagLogGroup",
  LOGS_LIST_TAGS_LOG_GROUP: "logs:ListTagsLogGroup",
  // S3
  S3_GET_OBJECT: "s3:GetObject",
  S3_PUT_BUCKET_POLICY: "s3:PutBucketPolicy",
  S3_GET_BUCKET_POLICY: "s3:GetBucketPolicy",
  // XRay
  XRAY_PUT_TRACE_SEGMENTS: "xray:PutTraceSegments",
  XRAY_PUT_TELEMETRY: "xray:PutTelemetryRecords",
  // Tagging
  TAG_TAG_RESOURCES: "tag:TagResources",
  TAG_GET_RESOURCES: "tag:GetResources",
  // A6 (2026-04-08) dropped LAMBDA_CREATE_ESM / LAMBDA_GET_ESM /
  //   LAMBDA_DELETE_ESM when Lambda::EventSourceMapping was migrated
  //   from SDK fallback to CCAPI.
  // A10 (2026-04-09) dropped SNS_SUBSCRIBE / SNS_UNSUBSCRIBE when
  //   SNS::Subscription was promoted from CCAPI_FALLBACK_TYPES to a
  //   first-class CCAPI type. The sns:Subscribe / sns:Unsubscribe
  //   perms now live inside the scoped SNS_SUBSCRIPTION entry in
  //   iam-actions.ts serviceActionMap.
  // No SDK-fallback actions remain — every first-class type flows
  // through CCAPI. The SSH key-pair companion perms
  // (ec2:CreateKeyPair / ec2:DeleteKeyPair / ec2:DescribeKeyPairs)
  // are unscoped in operatorPolicy() but live with the rest of the
  // EC2 actions in iam-actions.ts, not here.
} as const;

/** AWS service principals for IAM trust policies. */
export const AwsServicePrincipal = {
  LAMBDA: "lambda.amazonaws.com",
  EC2: "ec2.amazonaws.com",
  ECS_TASKS: "ecs-tasks.amazonaws.com",
  APIGATEWAY: "apigateway.amazonaws.com",
  CLOUDFRONT: "cloudfront.amazonaws.com",
  BEDROCK: "bedrock.amazonaws.com",
} as const;
