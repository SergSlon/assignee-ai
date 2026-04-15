/**
 * IAM actions for compute-family resource types:
 * Lambda, EC2 Instance, ECS Cluster, ECR Repository.
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const COMPUTE_ACTIONS: Record<string, string[]> = {
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
};
