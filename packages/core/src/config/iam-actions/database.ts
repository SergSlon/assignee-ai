/**
 * IAM actions for database/data-store resource types:
 * RDS (DBInstance + DBSubnetGroup), DynamoDB.
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const DATABASE_ACTIONS: Record<string, string[]> = {
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
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: [
    "rds:CreateDBInstance",
    "rds:DeleteDBInstance",
    "rds:DescribeDBInstances",
    "rds:ModifyDBInstance",
    "rds:AddTagsToResource",
    "rds:ListTagsForResource",
    // Snapshot permissions — RDS DeleteDBInstance validates these even
    // when SkipFinalSnapshot=true.
    "rds:CreateDBSnapshot",
    "rds:DeleteDBSnapshot",
    "rds:DescribeDBSnapshots",
    "rds:CopyDBSnapshot",
  ],
  [RESOURCE_TYPES.RDS_DB_SUBNET_GROUP]: [
    "rds:CreateDBSubnetGroup",
    "rds:DeleteDBSubnetGroup",
    "rds:DescribeDBSubnetGroups",
    "rds:ModifyDBSubnetGroup",
    "rds:AddTagsToResource",
    "rds:ListTagsForResource",
  ],
};
