/**
 * AWS ARN prefixes and managed policy ARNs — single source of truth.
 * Use instead of raw "arn:aws:..." strings in validation and policy definitions.
 */

/** ARN prefix for validation (e.g., `value.startsWith(ArnPrefix.IAM)`) */
export const ArnPrefix = {
  /** Generic AWS ARN prefix */
  AWS: "arn:aws:",
  /** IAM policy/role/user ARNs */
  IAM: "arn:aws:iam:",
  /** KMS key ARNs */
  KMS: "arn:aws:kms:",
  /** SNS topic ARNs */
  SNS: "arn:aws:sns:",
  /** SQS queue ARNs */
  SQS: "arn:aws:sqs:",
  /** S3 bucket ARNs */
  S3: "arn:aws:s3:",
  /** Lambda function ARNs */
  LAMBDA: "arn:aws:lambda:",
  /** EC2 resource ARNs */
  EC2: "arn:aws:ec2:",
  /** Bedrock model ARNs */
  BEDROCK: "arn:aws:bedrock:",
} as const;

/** KMS key alias prefix */
export const KMS_ALIAS_PREFIX = "alias/" as const;

/** AWS managed policy ARNs used in pattern templates and IAM configs. */
export const AwsManagedPolicy = {
  LAMBDA_BASIC_EXECUTION:
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  POWER_USER_ACCESS: "arn:aws:iam::aws:policy/PowerUserAccess",
} as const;

/** Default Bedrock foundation model ARN wildcard for IAM policies. */
export const BEDROCK_MODEL_ARN_WILDCARD =
  "arn:aws:bedrock:*::foundation-model/*" as const;

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
  // SDK fallback
  LAMBDA_CREATE_ESM: "lambda:CreateEventSourceMapping",
  LAMBDA_GET_ESM: "lambda:GetEventSourceMapping",
  LAMBDA_DELETE_ESM: "lambda:DeleteEventSourceMapping",
  SNS_SUBSCRIBE: "sns:Subscribe",
  SNS_UNSUBSCRIBE: "sns:Unsubscribe",
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
