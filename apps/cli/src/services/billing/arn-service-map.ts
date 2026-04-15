/**
 * ARN → Cost Explorer SERVICE dimension mapping.
 *
 * Extracted from billing.ts during Wave-6c decomposition. Kept partition-
 * aware (arn:aws-*) per feedback_partition_aware_arn_matching.
 */

/**
 * Maps an ARN service slug to its AWS service name as used in Cost Explorer's
 * SERVICE dimension. Best-effort — unknown services return undefined.
 *
 * e.g. "arn:aws:s3:::my-bucket" -> "Amazon Simple Storage Service"
 */
export const ARN_SERVICE_TO_CE_SERVICE: Record<string, string> = {
  s3: "Amazon Simple Storage Service",
  lambda: "AWS Lambda",
  ec2: "Amazon Elastic Compute Cloud - Compute",
  rds: "Amazon Relational Database Service",
  dynamodb: "Amazon DynamoDB",
  sqs: "Amazon Simple Queue Service",
  sns: "Amazon Simple Notification Service",
  ecs: "Amazon Elastic Container Service",
  elasticloadbalancing: "Amazon Elastic Load Balancing",
  cloudfront: "Amazon CloudFront",
  iam: "AWS Identity and Access Management",
  logs: "Amazon CloudWatch Logs",
  events: "Amazon EventBridge",
  secretsmanager: "AWS Secrets Manager",
  kms: "AWS Key Management Service",
};

/**
 * Extracts the AWS service slug from an ARN.
 * e.g. "arn:aws:s3:::my-bucket" -> "s3"
 *      "arn:aws:lambda:us-east-1:123:function:foo" -> "lambda"
 *
 * Partition-aware: accepts arn:aws:, arn:aws-cn:, arn:aws-us-gov:, etc.
 */
export function arnToServiceSlug(arn: string): string | undefined {
  // ARN format: arn:partition:service:region:account:resource
  const match = /^arn:aws[\w-]*:([^:]+):/.exec(arn);
  if (match) return match[1];
  // S3 ARNs may have empty region/account: arn:aws:s3:::bucket
  if (/^arn:aws[\w-]*:s3:/.test(arn)) return "s3";
  return undefined;
}
