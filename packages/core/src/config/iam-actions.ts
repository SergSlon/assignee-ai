/**
 * Maps CloudFormation resource types to the IAM actions required
 * for CloudControl API provisioning + service-specific bootstrapping.
 *
 * For unknown resource types, only the base CloudControl API actions are returned.
 * The mapping can be expanded incrementally as new resource types are added.
 *
 * @see Story 19.1 — IAM MCP Server Integration (FR-43)
 */

/**
 * Returns the IAM actions required to provision a given CloudFormation resource type.
 * Includes both CloudControl API base actions and service-specific actions.
 */
export function getRequiredIamActions(resourceType: string): string[] {
  const ccapiActions = [
    "cloudcontrol:CreateResource",
    "cloudcontrol:GetResource",
    "cloudcontrol:GetResourceRequestStatus",
    "cloudcontrol:UpdateResource",
    "cloudcontrol:DeleteResource",
    // CloudControl API maps internally to CloudFormation — some accounts
    // require these actions under the cloudformation namespace
    "cloudformation:GetResource",
    "cloudformation:GetResourceRequestStatus",
    "cloudformation:CreateResource",
    "cloudformation:DeleteResource",
    "cloudformation:UpdateResource",
  ];

  const serviceActionMap: Record<string, string[]> = {
    "AWS::S3::Bucket": ["s3:CreateBucket", "s3:PutBucketTagging"],
    "AWS::Lambda::Function": [
      "lambda:CreateFunction",
      "lambda:TagResource",
      "iam:PassRole",
    ],
    "AWS::DynamoDB::Table": ["dynamodb:CreateTable", "dynamodb:TagResource"],
    "AWS::SQS::Queue": ["sqs:CreateQueue", "sqs:TagQueue"],
    "AWS::SNS::Topic": ["sns:CreateTopic", "sns:TagResource"],
    "AWS::EC2::Instance": [
      "ec2:RunInstances",
      "ec2:CreateTags",
      "ec2:DescribeInstances",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeKeyPairs",
      "ec2:DescribeInstanceTypes",
      "ssm:GetParameter",
      "iam:PassRole",
    ],
    "AWS::RDS::DBInstance": ["rds:CreateDBInstance", "rds:AddTagsToResource"],
  };

  const serviceActions = serviceActionMap[resourceType] ?? [];
  return [...ccapiActions, ...serviceActions];
}
