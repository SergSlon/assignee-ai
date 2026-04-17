/**
 * Security posture advisor — analyzes desiredState for common security issues.
 * Complementary to BP rules: explains WHY, not just what.
 *
 * @see Story 40.5 — Security Posture Advisor
 */

import { RESOURCE_TYPES, CfnKey } from "../../../index.js";
import {
  Port,
  CIDR_ALL_IPV4,
  IMDSV2_REQUIRED,
  PRODUCTION_INTENT_PATTERN,
  AdviceIcon,
} from "./constants.js";

export function securityPosture(
  resourceType: string,
  desiredState: Record<string, unknown>,
  userIntent?: string,
): string[] {
  const hints: string[] = [];

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    ec2Security(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    s3Security(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    rdsSecurityChecks(desiredState, userIntent, hints);
  } else if (resourceType === RESOURCE_TYPES.EC2_SECURITY_GROUP) {
    sgSecurity(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    lambdaSecurity(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    dynamodbSecurity(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.SNS_TOPIC) {
    snsSecurity(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    sqsSecurity(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.SECRETSMANAGER_SECRET) {
    hints.push(
      `${AdviceIcon.SECURITY_OK} Secrets Manager encrypts secrets at rest by default using AWS-managed KMS keys`,
    );
  } else if (resourceType === RESOURCE_TYPES.ECR_REPOSITORY) {
    ecrSecurity(desiredState, hints);
  }

  return hints;
}

function ec2Security(ds: Record<string, unknown>, hints: string[]): void {
  // IMDSv2 check
  const metadataOptions = ds[CfnKey.METADATA_OPTIONS] as
    | Record<string, unknown>
    | undefined;
  if (metadataOptions?.["HttpTokens"] === IMDSV2_REQUIRED) {
    hints.push(
      `${AdviceIcon.SECURITY_OK} IMDSv2 enforced \u2014 instance metadata is protected against SSRF attacks`,
    );
  } else {
    hints.push(
      `${AdviceIcon.WARNING} IMDSv2 not enforced \u2014 set MetadataOptions.HttpTokens to '${IMDSV2_REQUIRED}' to prevent SSRF credential theft`,
    );
  }

  // EBS encryption check
  const blockDevices = ds[CfnKey.BLOCK_DEVICE_MAPPINGS] as
    | Array<Record<string, unknown>>
    | undefined;
  if (blockDevices && blockDevices.length > 0) {
    const hasUnencrypted = blockDevices.some((bd) => {
      const ebs = bd["Ebs"] as Record<string, unknown> | undefined;
      return ebs && ebs["Encrypted"] !== true;
    });
    if (hasUnencrypted) {
      hints.push(
        `${AdviceIcon.WARNING} EBS volume is unencrypted \u2014 add Ebs.Encrypted: true to protect data at rest`,
      );
    }
  }
}

function s3Security(ds: Record<string, unknown>, hints: string[]): void {
  // Encryption check
  if (!ds[CfnKey.BUCKET_ENCRYPTION]) {
    hints.push(
      `${AdviceIcon.WARNING} No explicit encryption configured \u2014 S3 encrypts by default (SSE-S3) but explicit BucketEncryption is recommended for compliance auditability`,
    );
  }

  // Public access block check
  const pab = ds[CfnKey.PUBLIC_ACCESS_BLOCK] as
    | Record<string, unknown>
    | undefined;
  if (!pab) {
    hints.push(
      `${AdviceIcon.WARNING} Public access block not configured \u2014 add PublicAccessBlockConfiguration with all four blocks enabled to prevent accidental public exposure`,
    );
  } else {
    const allBlocked =
      pab["BlockPublicAcls"] === true &&
      pab["BlockPublicPolicy"] === true &&
      pab["IgnorePublicAcls"] === true &&
      pab["RestrictPublicBuckets"] === true;
    if (allBlocked) {
      hints.push(
        `${AdviceIcon.SECURITY_OK} Public access fully blocked \u2014 bucket is protected from accidental public exposure`,
      );
    }
  }
}

function rdsSecurityChecks(
  ds: Record<string, unknown>,
  userIntent: string | undefined,
  hints: string[],
): void {
  // Storage encryption
  if (ds["StorageEncrypted"] !== true) {
    hints.push(
      `${AdviceIcon.WARNING} RDS storage encryption is disabled \u2014 set StorageEncrypted: true (cannot be enabled after creation without recreating the instance)`,
    );
  }

  // Multi-AZ for production
  const isProd = userIntent
    ? PRODUCTION_INTENT_PATTERN.test(userIntent)
    : false;
  if (isProd && ds[CfnKey.MULTI_AZ] !== true) {
    hints.push(
      `${AdviceIcon.WARNING} Production database without Multi-AZ \u2014 enable for automatic failover and high availability`,
    );
  }
}

function sgSecurity(ds: Record<string, unknown>, hints: string[]): void {
  const ingress = ds["SecurityGroupIngress"] as
    | Array<Record<string, unknown>>
    | undefined;
  if (!ingress) return;

  for (const rule of ingress) {
    const cidr = (rule["CidrIp"] as string) ?? "";
    const fromPort = rule["FromPort"] as number | undefined;
    const toPort = rule["ToPort"] as number | undefined;

    if (
      cidr === CIDR_ALL_IPV4 &&
      fromPort === Port.SSH &&
      toPort === Port.SSH
    ) {
      hints.push(
        `${AdviceIcon.WARNING} SSH (port ${Port.SSH}) is open to the entire internet (${CIDR_ALL_IPV4}) \u2014 restrict to your IP range or use SSM Session Manager instead`,
      );
    }
  }
}

function lambdaSecurity(ds: Record<string, unknown>, hints: string[]): void {
  // Check for overly permissive role
  const role = ds["Role"] as string | undefined;
  if (role && /AdministratorAccess|FullAccess/i.test(role)) {
    hints.push(
      `${AdviceIcon.WARNING} Lambda role appears overly permissive \u2014 follow least-privilege: grant only the specific actions this function needs`,
    );
  }
  // DLQ recommendation
  if (!ds["DeadLetterConfig"]) {
    hints.push(
      `${AdviceIcon.WARNING} No Dead Letter Queue configured \u2014 failed async invocations will be silently dropped. Add an SQS DLQ.`,
    );
  }
}

function dynamodbSecurity(ds: Record<string, unknown>, hints: string[]): void {
  if (ds["SSESpecification"] === undefined) {
    hints.push(
      `${AdviceIcon.SECURITY_OK} DynamoDB encrypts all data at rest by default using AWS-owned keys \u2014 for compliance, consider specifying SSESpecification with a CMK`,
    );
  }
  if (!ds["PointInTimeRecoverySpecification"]) {
    hints.push(
      `${AdviceIcon.WARNING} Point-in-time recovery (PITR) not enabled \u2014 without it, accidental deletes cannot be undone`,
    );
  }
}

function snsSecurity(ds: Record<string, unknown>, hints: string[]): void {
  if (!ds["KmsMasterKeyId"]) {
    hints.push(
      `${AdviceIcon.WARNING} SNS topic is not encrypted with a custom KMS key \u2014 messages in transit between publishers and subscribers are exposed`,
    );
  }
}

function sqsSecurity(ds: Record<string, unknown>, hints: string[]): void {
  if (!ds["KmsMasterKeyId"] && !ds["SqsManagedSseEnabled"]) {
    hints.push(
      `${AdviceIcon.WARNING} SQS queue encryption not configured \u2014 enable SqsManagedSseEnabled or provide a KMS key for at-rest encryption`,
    );
  }
}

function ecrSecurity(ds: Record<string, unknown>, hints: string[]): void {
  if (!ds["ImageScanningConfiguration"]) {
    hints.push(
      `${AdviceIcon.WARNING} Image scanning not enabled \u2014 enable scanOnPush to detect vulnerabilities in container images`,
    );
  }
  if (!ds["EncryptionConfiguration"]) {
    hints.push(
      `${AdviceIcon.SECURITY_OK} ECR encrypts images at rest by default using AES-256 \u2014 for compliance, consider KMS encryption`,
    );
  }
}
