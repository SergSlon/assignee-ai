export const BEDROCK_MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "us.amazon.nova-lite-v1:0";

export const AWS_REGION = process.env["AWS_REGION"] ?? "us-east-1";

export const SUPPORTED_TYPES = [
  "AWS::S3::Bucket",
  "AWS::SSM::Parameter",
  "AWS::IAM::Role",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::Lambda::Function",
] as const;

export type SupportedType = (typeof SUPPORTED_TYPES)[number];

/** Human-readable hint shown when an unsupported resource type is requested. */
export const SUPPORTED_TYPES_HINT = `Supported types: ${SUPPORTED_TYPES.join(", ")}`;

/** Maximum characters of the CFN schema excerpt passed to the plan generator prompt. */
export const SCHEMA_EXCERPT_MAX_CHARS = 3000;
