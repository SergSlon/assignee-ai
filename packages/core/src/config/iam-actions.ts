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
    "AWS::SSM::Parameter": [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:DeleteParameter",
      "ssm:AddTagsToResource",
      "ssm:ListTagsForResource",
    ],
    "AWS::EC2::Instance": [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
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
    "AWS::EC2::SecurityGroup": [
      "ec2:CreateSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:CreateTags",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeVpcs",
    ],
    "AWS::EC2::VPC": [
      "ec2:CreateVpc",
      "ec2:ModifyVpcAttribute",
      "ec2:CreateTags",
      "ec2:DescribeVpcs",
    ],
    "AWS::IAM::Role": [
      "iam:CreateRole",
      "iam:AttachRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:PassRole",
    ],
    "AWS::EC2::Subnet": [
      "ec2:CreateSubnet",
      "ec2:CreateTags",
      "ec2:DescribeSubnets",
      "ec2:DescribeAvailabilityZones",
    ],
    "AWS::ECS::Cluster": [
      "ecs:CreateCluster",
      "ecs:PutClusterCapacityProviders",
      "ecs:TagResource",
    ],
    "AWS::ECR::Repository": [
      "ecr:CreateRepository",
      "ecr:PutImageScanningConfiguration",
      "ecr:PutLifecyclePolicy",
      "ecr:TagResource",
    ],
    "AWS::ElasticLoadBalancingV2::LoadBalancer": [
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:AddTags",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
    ],
  };

  const serviceActions = serviceActionMap[resourceType] ?? [];
  return [...ccapiActions, ...serviceActions];
}
