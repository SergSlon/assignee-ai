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
    // A11 (2026-04-09): AWS::KMS::Key — first-class (symmetric CMK).
    // CCAPI handler permissions probed 2026-04-09 — union of create,
    // read, update, delete, list handlers:
    //   kms:CreateKey, kms:ScheduleKeyDeletion, kms:DescribeKey,
    //   kms:EnableKey, kms:DisableKey,
    //   kms:EnableKeyRotation, kms:DisableKeyRotation,
    //   kms:GetKeyRotationStatus,
    //   kms:PutKeyPolicy, kms:GetKeyPolicy, kms:UpdateKeyDescription,
    //   kms:TagResource, kms:UntagResource, kms:ListResourceTags,
    //   kms:ListKeys
    // The Get*/Describe*/List* subset collapses into existing wildcard
    // prefixes (SAFE_WILDCARD_PREFIXES), so the net byte cost to the
    // services policy is mostly the Create/Delete/Enable/Disable/Put/
    // Update/Tag/Untag verbs that cannot collapse.
    [RESOURCE_TYPES.KMS_KEY]: [
      "kms:CreateKey",
      "kms:ScheduleKeyDeletion",
      "kms:DescribeKey",
      "kms:EnableKey",
      "kms:DisableKey",
      "kms:EnableKeyRotation",
      "kms:DisableKeyRotation",
      "kms:GetKeyRotationStatus",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:UpdateKeyDescription",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ListResourceTags",
      "kms:ListKeys",
    ],
    // A10 (2026-04-09): AWS::SNS::Subscription — first-class.
    // CCAPI handler permissions probed 2026-04-09:
    //   create: iam:GetRole, iam:PassRole, sns:Subscribe
    //   read:   sns:GetSubscriptionAttributes
    //   update: iam:GetRole, iam:PassRole, sns:SetSubscriptionAttributes
    //   delete: sns:Unsubscribe, sns:GetSubscriptionAttributes
    //   list:   sns:ListSubscriptions
    // iam:GetRole + iam:PassRole are only needed when creating a
    // Firehose delivery-stream subscription with SubscriptionRoleArn
    // — we grab them anyway so that path works without a second
    // round of policy edits. Tagging is NOT supported (schema
    // reports tagging.taggable=false), so no sns:Tag* actions.
    [RESOURCE_TYPES.SNS_SUBSCRIPTION]: [
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:GetSubscriptionAttributes",
      "sns:SetSubscriptionAttributes",
      "sns:ListSubscriptions",
      "sns:ListSubscriptionsByTopic",
      "iam:GetRole",
      "iam:PassRole",
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
      // Required by list-resources and destroy-service to enumerate
      // managed IAM roles. AWS Resource Groups Tagging API does NOT
      // return IAM::Role resources (it covers IAM users, groups,
      // managed policies, server certificates, and SAML providers but
      // not roles), so assignee falls back to a parallel iam:ListRoles
      // + iam:ListRoleTags scan filtered by managed-by=assignee-ai.
      // Without these permissions, freshly-created roles are invisible
      // to `assignee list` and `assignee destroy --all`.
      "iam:ListRoles",
      "iam:ListRoleTags",
      // Required by CloudControl DeleteResource(AWS::IAM::Role) to
      // enumerate and detach all attached/inline policies before
      // deleting the role itself. Without these the destroy path
      // fails with "is not authorized to perform: iam:ListRolePolicies
      // on resource: role X" even though the role has no policies.
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:GetRolePolicy",
      // Wave 19 Bug #8: preflight verifies every ManagedPolicyArn against
      // IAM with iam:GetPolicy before CCAPI sees it, so the LLM can't
      // hallucinate a non-existent ARN past the gate. Without this perm
      // the preflight verifier fails open (no block) and a hallucinated
      // ARN reaches CCAPI which then 404s with a less actionable error.
      "iam:GetPolicy",
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
      // Wave 19 Bug #5: EIP-reuse pre-hook calls DescribeAddresses before
      // allocating a new EIP. Missing perm caused silent fall-through to
      // "always allocate" which, combined with Bug #6 (EIP not in bulk-destroy
      // tier table), produced a monotonic EIP leak loop observed against
      // live AWS on 2026-04-08 (5 orphaned EIPs recovered from prior runs).
      "ec2:DescribeAddresses",
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
    // A1 (2026-04-08): EFS. Minimum-viable set — the 9 actions below
    // are the strict subset of the CCAPI create/delete handler perms
    // (verified via cloudformation:DescribeType probe on 2026-04-08)
    // that cannot be omitted without breaking create+tag+delete. The
    // three Describe* actions meet the 3-member threshold so
    // collapseToWildcards() collapses them to a single
    // `elasticfilesystem:Describe*` wildcard, which at runtime still
    // grants the full set the EFS handler calls (DescribeBackupPolicy,
    // DescribeFileSystemPolicy, DescribeFileSystems,
    // DescribeLifecycleConfiguration, DescribeReplicationConfigurations).
    //
    // Intentionally omitted to keep the operator policy within the
    // 6144-byte limit (promote to this list only if a user flow hits
    // a MissingPermission error):
    //   - elasticfilesystem:UpdateFileSystem      (CCAPI treats update as replace)
    //   - elasticfilesystem:PutLifecycleConfiguration (IA tiering is an advanced feature)
    //   - elasticfilesystem:PutFileSystemPolicy   (resource policy is an advanced feature)
    //   - elasticfilesystem:UpdateFileSystemProtection (rarely used)
    //   - elasticfilesystem:ListTagsForResource   (not needed for create/delete)
    //   - elasticfilesystem:UntagResource         (drift reconcile, future A3)
    //   - iam:CreateServiceLinkedRole             (one-time per account; already
    //                                              created by the time this tool is used;
    //                                              users with a fresh account get a
    //                                              clear error pointing at the missing perm)
    [RESOURCE_TYPES.EFS_FILE_SYSTEM]: [
      "elasticfilesystem:CreateFileSystem",
      "elasticfilesystem:DeleteFileSystem",
      "elasticfilesystem:DescribeFileSystems",
      "elasticfilesystem:DescribeBackupPolicy",
      "elasticfilesystem:DescribeReplicationConfigurations",
      "elasticfilesystem:PutBackupPolicy",
      "elasticfilesystem:TagResource",
      // Encryption: KMS grant creation for customer-managed keys. The
      // CCAPI create handler explicitly requires GenerateDataKey +
      // CreateGrant; DescribeKey is already granted via other resource
      // types so it gets deduped across the Set.
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:CreateGrant",
    ],
    // A1 follow-up: EFS MountTarget. Minimum-viable set — Create +
    // Delete only. The Describe* actions are shared with the
    // FileSystem type and collapse into the existing
    // elasticfilesystem:Describe* wildcard for free. Modify/update
    // flows (ModifyMountTargetSecurityGroups) are deferred — they
    // require ~50 bytes the operator policy cannot currently spare
    // (see the policy-size comment above). Users who need to rotate
    // mount-target security groups can add them to the policy
    // post-setup.
    [RESOURCE_TYPES.EFS_MOUNT_TARGET]: [
      "elasticfilesystem:CreateMountTarget",
      "elasticfilesystem:DeleteMountTarget",
    ],
    // A8 (2026-04-08): EventBridge Rule first-class promotion.
    // Minimum viable set: PutRule covers Create+Update, DeleteRule
    // for destroy, DescribeRule for drift, PutTargets/RemoveTargets
    // for target attach/detach (create + update paths both call
    // PutTargets), TagResource for plan-time tagging. The 3 List*
    // actions collapse to `events:List*` via collapseToWildcards()
    // (Describe/List/Get threshold = 3+ members). Deliberately
    // omitted to keep the operator policy inside 6144-byte limit:
    //   - events:EnableRule / DisableRule  — CCAPI UpdateResource
    //     mutates `State` via the same PutRule path
    //   - events:UntagResource             — drift reconcile, future
    //   - iam:PassRole                     — already granted via
    //     other resource types (EC2_INSTANCE, LAMBDA_FUNCTION,
    //     IAM_ROLE) and deduped in the Set
    [RESOURCE_TYPES.EVENTS_RULE]: [
      "events:PutRule",
      "events:DeleteRule",
      "events:DescribeRule",
      "events:PutTargets",
      "events:RemoveTargets",
      "events:TagResource",
    ],
    // A9 (2026-04-09): AWS::Events::EventBus minimum viable set.
    // CreateEventBus + DeleteEventBus + DescribeEventBus cover the
    // core lifecycle. PutPermission/RemovePermission are needed for
    // cross-account event publishing (the canonical use case for
    // custom event buses) — without them users would have to grant
    // post-apply via the console. ListEventBuses is needed for the
    // state guard's Read-Before-Write check via CCAPI GetResource.
    // Together with the existing events:Describe* + events:List*
    // collapsed wildcards (introduced for Events::Rule), this adds
    // ~150 bytes to the operatorServicesPolicy — well inside the
    // ~1600-byte headroom restored by the A8 split.
    [RESOURCE_TYPES.EVENTS_EVENT_BUS]: [
      "events:CreateEventBus",
      "events:DeleteEventBus",
      "events:DescribeEventBus",
      "events:ListEventBuses",
      "events:PutPermission",
      "events:RemovePermission",
      "events:TagResource",
    ],
  };

  const serviceActions = serviceActionMap[resourceType] ?? [];
  return [...ccapiActions, ...serviceActions];
}
