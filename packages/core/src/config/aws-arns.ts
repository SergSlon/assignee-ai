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

/** AWS service principals for IAM trust policies. */
export const AwsServicePrincipal = {
  LAMBDA: "lambda.amazonaws.com",
  EC2: "ec2.amazonaws.com",
  ECS_TASKS: "ecs-tasks.amazonaws.com",
  APIGATEWAY: "apigateway.amazonaws.com",
  CLOUDFRONT: "cloudfront.amazonaws.com",
  BEDROCK: "bedrock.amazonaws.com",
} as const;
