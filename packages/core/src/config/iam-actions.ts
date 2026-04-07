/**
 * Maps CloudFormation resource types to the IAM actions required
 * for CloudControl API provisioning + service-specific bootstrapping.
 *
 * For unknown resource types, only the base CloudControl API actions are returned.
 * The mapping can be expanded incrementally as new resource types are added.
 *
 * @see Story 19.1 — IAM MCP Server Integration (FR-43)
 */

import { RESOURCE_TYPES } from "./resource-types.js";

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
    [RESOURCE_TYPES.S3_BUCKET]: [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:GetBucket*",
      "s3:PutBucket*",
      "s3:DeleteBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:PutReplicationConfiguration",
      "s3:GetIntelligentTieringConfiguration",
      "s3:PutIntelligentTieringConfiguration",
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
      // Required by destroy-service.ts to enumerate and delete versioned
      // objects and delete markers before bulk-deleting a versioned bucket.
      // Without these, ListObjectVersions/DeleteObjects(VersionId=...) emit
      // a scary "not authorized" warning even though the operation appears
      // to succeed against unversioned buckets.
      "s3:ListBucketVersions",
      "s3:DeleteObjectVersion",
      // CloudFront for static websites (Epic 37)
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:TagResource",
    ],
    [RESOURCE_TYPES.LAMBDA_FUNCTION]: [
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:GetFunction",
      "lambda:UpdateFunctionConfiguration",
      "lambda:UpdateFunctionCode",
      "lambda:TagResource",
      "lambda:ListTags",
      "iam:PassRole",
    ],
    [RESOURCE_TYPES.DYNAMODB_TABLE]: [
      "dynamodb:CreateTable",
      "dynamodb:DeleteTable",
      "dynamodb:DescribeTable",
      "dynamodb:UpdateTable",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:TagResource",
      "dynamodb:ListTagsOfResource",
    ],
    [RESOURCE_TYPES.SQS_QUEUE]: [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:TagQueue",
      "sqs:ListQueueTags",
    ],
    [RESOURCE_TYPES.SNS_TOPIC]: [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:GetTopicAttributes",
      "sns:SetTopicAttributes",
      "sns:TagResource",
      "sns:ListTagsForResource",
    ],
    [RESOURCE_TYPES.SSM_PARAMETER]: [
      "ssm:PutParameter",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath", // E2E sweeper + bulk list by prefix
      "ssm:DescribeParameters", // E2E sweeper fallback
      "ssm:DeleteParameter",
      "ssm:AddTagsToResource",
      "ssm:ListTagsForResource",
    ],
    [RESOURCE_TYPES.EC2_INSTANCE]: [
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:CreateTags",
      "ec2:DescribeInstances",
      "ec2:ModifyInstanceAttribute",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeKeyPairs",
      "ec2:CreateKeyPair", // SSH intent bundle auto-create
      "ec2:DeleteKeyPair", // SSH intent rollback on provision failure
      "ec2:DescribeInstanceTypes",
      "ssm:GetParameter",
      "iam:PassRole",
    ],
    [RESOURCE_TYPES.RDS_DB_INSTANCE]: [
      "rds:CreateDBInstance",
      "rds:DeleteDBInstance",
      "rds:DescribeDBInstances",
      "rds:ModifyDBInstance",
      "rds:AddTagsToResource",
      "rds:ListTagsForResource",
    ],
    [RESOURCE_TYPES.EC2_SECURITY_GROUP]: [
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupEgress",
      "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
      "ec2:CreateTags",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeVpcs",
    ],
    [RESOURCE_TYPES.EC2_VPC]: [
      "ec2:CreateVpc",
      "ec2:DeleteVpc",
      "ec2:ModifyVpcAttribute",
      "ec2:DescribeVpcs",
      "ec2:CreateTags",
    ],
    [RESOURCE_TYPES.IAM_ROLE]: [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:TagRole",
      "iam:PassRole",
    ],
    [RESOURCE_TYPES.EC2_SUBNET]: [
      "ec2:CreateSubnet",
      "ec2:DeleteSubnet",
      "ec2:DescribeSubnets",
      "ec2:ModifySubnetAttribute",
      "ec2:CreateTags",
      "ec2:DescribeAvailabilityZones",
    ],
    [RESOURCE_TYPES.ECS_CLUSTER]: [
      "ecs:CreateCluster",
      "ecs:DeleteCluster",
      "ecs:DescribeClusters",
      "ecs:UpdateCluster",
      "ecs:PutClusterCapacityProviders",
      "ecs:TagResource",
    ],
    [RESOURCE_TYPES.ECR_REPOSITORY]: [
      "ecr:CreateRepository",
      "ecr:DeleteRepository",
      "ecr:DescribeRepositories",
      "ecr:PutImageScanningConfiguration",
      "ecr:PutLifecyclePolicy",
      "ecr:SetRepositoryPolicy",
      "ecr:TagResource",
    ],
    [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: [
      "elasticloadbalancing:CreateLoadBalancer",
      "elasticloadbalancing:DeleteLoadBalancer",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:ModifyLoadBalancerAttributes",
      "elasticloadbalancing:AddTags",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
    ],
    // Sprint F: Tier 1 resources (Epic 25)
    [RESOURCE_TYPES.LOGS_LOG_GROUP]: [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy",
      "logs:TagLogGroup",
      "logs:ListTagsLogGroup",
    ],
    [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: [
      "ec2:CreateInternetGateway",
      "ec2:DeleteInternetGateway",
      "ec2:DescribeInternetGateways",
      "ec2:AttachInternetGateway",
      "ec2:DetachInternetGateway",
      "ec2:CreateTags",
    ],
    [RESOURCE_TYPES.EC2_ROUTE_TABLE]: [
      "ec2:CreateRouteTable",
      "ec2:DeleteRouteTable",
      "ec2:DescribeRouteTables",
      "ec2:AssociateRouteTable",
      "ec2:DisassociateRouteTable",
      "ec2:CreateTags",
    ],
    [RESOURCE_TYPES.EC2_ROUTE]: [
      "ec2:CreateRoute",
      "ec2:DeleteRoute",
      "ec2:ReplaceRoute",
      "ec2:DescribeRouteTables",
    ],
    [RESOURCE_TYPES.EC2_NAT_GATEWAY]: [
      "ec2:CreateNatGateway",
      "ec2:DeleteNatGateway",
      "ec2:DescribeNatGateways",
      "ec2:CreateTags",
      "ec2:AllocateAddress",
      "ec2:ReleaseAddress",
    ],
    // Sprint G: Tier 2 resources (Epic 26)
    [RESOURCE_TYPES.APIGATEWAYV2_API]: [
      "apigateway:CreateApi",
      "apigateway:DeleteApi",
      "apigateway:GetApi",
      "apigateway:UpdateApi",
      "apigateway:CreateRoute",
      "apigateway:CreateIntegration",
      "apigateway:CreateStage",
      "apigateway:CreateDeployment",
      "apigateway:TagResource",
    ],
    [RESOURCE_TYPES.CLOUDWATCH_ALARM]: [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DeleteAlarms",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:SetAlarmState",
      "cloudwatch:TagResource",
      "cloudwatch:EnableAlarmActions",
      "cloudwatch:DisableAlarmActions",
    ],
    [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: [
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:UpdateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
      "secretsmanager:TagResource",
    ],
  };

  const serviceActions = serviceActionMap[resourceType] ?? [];
  return [...ccapiActions, ...serviceActions];
}
