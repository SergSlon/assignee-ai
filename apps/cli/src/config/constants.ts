export const BEDROCK_MODEL_ID =
  process.env["BEDROCK_MODEL_ID"] ?? "us.amazon.nova-lite-v1:0";

export const AWS_REGION = process.env["AWS_REGION"] ?? "us-east-1";

export const SUPPORTED_POC_TYPES = [
  "AWS::S3::Bucket",
  "AWS::SSM::Parameter",
  "AWS::IAM::Role",
] as const;

export type SupportedPocType = (typeof SUPPORTED_POC_TYPES)[number];
