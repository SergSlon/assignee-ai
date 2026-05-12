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
    // DF-DDB-TTL-IAM-MISSING (live dogfood 2026-05-11): CCAPI creates
    // the table successfully, then issues a separate UpdateTimeToLive
    // API call when the intent declares TimeToLiveSpecification. The
    // create succeeds; the TTL enable fails with "is not authorized to
    // perform: dynamodb:UpdateTimeToLive" → table is leaked
    // half-configured. DescribeTimeToLive is paired so describe-then-
    // update flows work for idempotent re-runs.
    "dynamodb:UpdateTimeToLive",
    "dynamodb:DescribeTimeToLive",
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
