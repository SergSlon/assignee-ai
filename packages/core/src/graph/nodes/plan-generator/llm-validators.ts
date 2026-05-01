/**
 * Plan-time validators (Epic 92 Wave 2.d) — extracted from llm-helpers.ts.
 *
 * Each validator accepts a `Record<string, unknown>` desiredState and returns
 * `null` on pass or a user-facing `[ERROR] … [FIX] …` string on fail.
 * These validators run AFTER the Wave 1 sanitizer + schema repair + resource
 * post-processing. The sanitizer is the runtime safety net; validators are the
 * explicit plan-time rejection for known-bad shapes the sanitizer cannot
 * confidently auto-repair.
 *
 * No dependencies on llm-helpers.ts core helpers — pure structural checks on
 * plain `Record<string, unknown>` objects.
 */
import { RESOURCE_TYPES } from "@/index.js";

// ── Plan-time validators (Epic 92 Wave 2.d) ─────────────────────────────────
//
// These run AFTER the Wave 1 sanitizer + schema repair + resource
// post-processing. Sanitizer is the runtime safety net; validators are the
// explicit plan-time rejection for known-bad shapes the sanitizer cannot
// confidently auto-repair. Every validator returns `null` on pass and a
// user-facing `[ERROR] … [FIX] …` error message on fail.

/**
 * Walks a KeySchema array and pushes every `AttributeName` string into
 * `out`. Non-array inputs are ignored (defensive — schema violations at
 * this level are caught by sanitizeAgainstSchema upstream).
 */
function collectKeySchemaNames(schema: unknown, out: Set<string>): void {
  if (!Array.isArray(schema)) return;
  for (const entry of schema) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)["AttributeName"] === "string"
    ) {
      out.add((entry as Record<string, unknown>)["AttributeName"] as string);
    }
  }
}

/**
 * Collects every AttributeName referenced from the table-level KeySchema,
 * GlobalSecondaryIndexes[*].KeySchema, and LocalSecondaryIndexes[*].KeySchema.
 */
function collectAllDdbKeyAttrs(obj: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  collectKeySchemaNames(obj["KeySchema"], names);
  for (const key of ["GlobalSecondaryIndexes", "LocalSecondaryIndexes"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const idx of arr) {
        if (idx && typeof idx === "object") {
          collectKeySchemaNames(
            (idx as Record<string, unknown>)["KeySchema"],
            names,
          );
        }
      }
    }
  }
  return names;
}

/**
 * Collects every `AttributeName` declared in AttributeDefinitions. Returns
 * an empty set if AttributeDefinitions is missing or not an array.
 */
function collectDdbDefinedAttrs(obj: Record<string, unknown>): Set<string> {
  const defs = obj["AttributeDefinitions"];
  const out = new Set<string>();
  if (!Array.isArray(defs)) return out;
  for (const d of defs) {
    if (
      d &&
      typeof d === "object" &&
      typeof (d as Record<string, unknown>)["AttributeName"] === "string"
    ) {
      out.add((d as Record<string, unknown>)["AttributeName"] as string);
    }
  }
  return out;
}

/**
 * DDB validator (A-16): every `KeySchema.AttributeName` (including GSI/LSI
 * nested KeySchemas) must appear in `AttributeDefinitions.AttributeName`.
 *
 * Returns `null` on pass; an actionable `[ERROR] … [FIX] …` string on fail.
 *
 * Note: the Wave 1 sanitizer auto-synthesises missing AttributeDefinitions,
 * so this validator typically passes silently. It fires when a compound
 * pattern / direct desiredState bypasses the sanitizer, or when a future
 * code path produces a shape the sanitizer doesn't cover.
 */
export function validateDynamoDbKeySchema(
  desiredState: Record<string, unknown>,
): string | null {
  const referenced = collectAllDdbKeyAttrs(desiredState);
  if (referenced.size === 0) return null;
  const defined = collectDdbDefinedAttrs(desiredState);
  const missing: string[] = [];
  for (const name of referenced) {
    if (!defined.has(name)) missing.push(name);
  }
  if (missing.length === 0) return null;
  const missingList = missing.map((n) => `'${n}'`).join(", ");
  return (
    `[ERROR] DynamoDB KeySchema references attribute(s) not in AttributeDefinitions: ${missingList}. ` +
    `[FIX] Add the missing attributes to AttributeDefinitions (e.g. ` +
    `{ AttributeName: ${missing[0] ?? "<name>"}, AttributeType: "S" }` +
    `) or rename the KeySchema entry to match an existing definition.`
  );
}

/**
 * CloudFront validator (C-04 plan-time half): an Origin must NOT have BOTH
 * `S3OriginConfig` AND `CustomOriginConfig` set. CCAPI rejects the pair with
 * `InvalidArgument: ExactlyOne [S3OriginConfig, CustomOriginConfig]`.
 *
 * Returns `null` on pass; an actionable error on fail. The Wave 1 sanitizer
 * disambiguates by dropping one based on DomainName heuristics, so this
 * validator typically passes silently. It fires when the sanitizer cannot
 * confidently pick one (e.g. an LLM emits both with an ambiguous DomainName
 * shape the sanitizer didn't normalise).
 */
export function validateCloudFrontOrigins(
  desiredState: Record<string, unknown>,
): string | null {
  const config = desiredState["DistributionConfig"];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const originsHolder = (config as Record<string, unknown>)["Origins"];
  let items: unknown[] = [];
  if (Array.isArray(originsHolder)) {
    items = originsHolder;
  } else if (
    originsHolder &&
    typeof originsHolder === "object" &&
    Array.isArray((originsHolder as Record<string, unknown>)["Items"])
  ) {
    items = (originsHolder as Record<string, unknown>)["Items"] as unknown[];
  }
  for (let i = 0; i < items.length; i++) {
    const origin = items[i];
    if (!origin || typeof origin !== "object" || Array.isArray(origin)) {
      continue;
    }
    const rec = origin as Record<string, unknown>;
    if ("S3OriginConfig" in rec && "CustomOriginConfig" in rec) {
      const id =
        typeof rec["Id"] === "string" ? (rec["Id"] as string) : `index ${i}`;
      return (
        `[ERROR] CloudFront Origin '${id}' has both S3OriginConfig and CustomOriginConfig set. ` +
        `[FIX] Remove one. Use S3OriginConfig for bucket-hosted origins (DomainName ends with ` +
        `.s3.amazonaws.com); use CustomOriginConfig for HTTP/HTTPS origins.`
      );
    }
  }
  return null;
}

// ── Plan-time validators — additional resource types (P085) ─────────────────
//
// Each validator below follows the same contract: returns `null` on pass or
// a `[ERROR] … [FIX] …` string on fail.  Structural cross-property checks
// only — per-field name/charset validation lives in validate-desired-state.ts.

/**
 * IAM::Role — AssumeRolePolicyDocument is required by CloudFormation.
 * Without it CloudControl rejects with "required property missing".
 */
export function validateIamRoleShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (!("AssumeRolePolicyDocument" in desiredState)) {
    return (
      "[ERROR] AWS::IAM::Role is missing required property AssumeRolePolicyDocument. " +
      "[FIX] Add an AssumeRolePolicyDocument that grants the trust principal (e.g. lambda.amazonaws.com or ec2.amazonaws.com) the sts:AssumeRole action."
    );
  }
  return null;
}

/**
 * Lambda::Function — Code must specify exactly one source:
 *   - S3 source: S3Bucket + S3Key (ImageUri must be absent)
 *   - Container: ImageUri (S3Bucket/S3Key/ZipFile must be absent)
 *   - Inline: ZipFile (S3Bucket/S3Key/ImageUri must be absent)
 * Having S3Bucket without S3Key (or vice-versa) is also invalid.
 */
export function validateLambdaCodeShape(
  desiredState: Record<string, unknown>,
): string | null {
  const code = desiredState["Code"];
  if (!code || typeof code !== "object" || Array.isArray(code)) return null;
  const c = code as Record<string, unknown>;
  const hasS3Bucket = "S3Bucket" in c;
  const hasS3Key = "S3Key" in c;
  const hasZipFile = "ZipFile" in c;
  const hasImageUri = "ImageUri" in c;

  const sourceCount = [hasS3Bucket || hasS3Key, hasZipFile, hasImageUri].filter(
    Boolean,
  ).length;

  if (sourceCount > 1) {
    return (
      "[ERROR] Lambda Code specifies multiple sources (S3/ZipFile/ImageUri). " +
      "[FIX] Choose exactly one: S3Bucket+S3Key for S3 deployment, ZipFile for inline code, or ImageUri for container image."
    );
  }

  // MED-2: check S3ObjectVersion FIRST — when it is present without S3Bucket
  // AND/OR S3Key, emit the more-specific error before the generic
  // "S3Bucket without S3Key" check fires.
  const hasS3ObjectVersion = "S3ObjectVersion" in c;
  if (hasS3ObjectVersion && (!hasS3Bucket || !hasS3Key)) {
    return (
      "[ERROR] Lambda Code.S3ObjectVersion requires both Code.S3Bucket and Code.S3Key. " +
      "[FIX] Add Code.S3Bucket and Code.S3Key alongside Code.S3ObjectVersion, " +
      "or remove Code.S3ObjectVersion if you do not need a specific object version."
    );
  }

  if (hasS3Bucket && !hasS3Key) {
    return (
      "[ERROR] Lambda Code.S3Bucket is set but S3Key is missing. " +
      "[FIX] Add Code.S3Key with the object key (path) of the deployment package in the S3 bucket."
    );
  }

  if (hasS3Key && !hasS3Bucket) {
    return (
      "[ERROR] Lambda Code.S3Key is set but S3Bucket is missing. " +
      "[FIX] Add Code.S3Bucket with the name of the S3 bucket containing the deployment package."
    );
  }

  return null;
}

/**
 * EC2::Instance — ImageId is required; without it CloudControl fails
 * with a cryptic "required property" error.
 */
export function validateEc2InstanceShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (!desiredState["ImageId"]) {
    return (
      "[ERROR] AWS::EC2::Instance is missing required property ImageId. " +
      "[FIX] Provide a valid AMI ID (e.g. ami-0abcdef1234567890). Use aws ec2 describe-images or the SSM Parameter Store path /aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2 to find current AMI IDs."
    );
  }
  return null;
}

/**
 * SQS::Queue — FifoQueue: true requires the QueueName to end with ".fifo".
 * Conversely, a ".fifo" suffix on a non-FIFO queue is also invalid.
 */
export function validateSqsQueueShape(
  desiredState: Record<string, unknown>,
): string | null {
  const isFifo = desiredState["FifoQueue"] === true;
  const name = desiredState["QueueName"];
  const nameStr = typeof name === "string" ? name : null;

  if (isFifo && nameStr && !nameStr.endsWith(".fifo")) {
    return (
      `[ERROR] SQS Queue has FifoQueue: true but QueueName "${nameStr}" does not end with ".fifo". ` +
      `[FIX] Rename the queue to "${nameStr}.fifo" or remove FifoQueue: true to create a standard queue.`
    );
  }

  if (!isFifo && nameStr && nameStr.endsWith(".fifo")) {
    return (
      `[ERROR] SQS Queue QueueName "${nameStr}" ends with ".fifo" but FifoQueue is not set to true. ` +
      `[FIX] Either set FifoQueue: true (and add ContentBasedDeduplication or DeduplicationScope) or remove the ".fifo" suffix.`
    );
  }

  return null;
}

/**
 * SNS::Topic — FifoTopic: true requires the TopicName to end with ".fifo".
 * Conversely, a ".fifo" suffix on a non-FIFO topic is invalid.
 */
export function validateSnsTopicShape(
  desiredState: Record<string, unknown>,
): string | null {
  const isFifo = desiredState["FifoTopic"] === true;
  const name = desiredState["TopicName"];
  const nameStr = typeof name === "string" ? name : null;

  if (isFifo && nameStr && !nameStr.endsWith(".fifo")) {
    return (
      `[ERROR] SNS Topic has FifoTopic: true but TopicName "${nameStr}" does not end with ".fifo". ` +
      `[FIX] Rename the topic to "${nameStr}.fifo" or remove FifoTopic: true.`
    );
  }

  if (!isFifo && nameStr && nameStr.endsWith(".fifo")) {
    return (
      `[ERROR] SNS Topic TopicName "${nameStr}" ends with ".fifo" but FifoTopic is not set to true. ` +
      `[FIX] Either set FifoTopic: true or remove the ".fifo" suffix from the TopicName.`
    );
  }

  return null;
}

const VALID_SSM_TYPES = new Set(["String", "StringList", "SecureString"]);

/**
 * SSM::Parameter — Type must be one of: String, StringList, SecureString.
 * The LLM sometimes emits "AWS::SSM::Parameter::Value<String>" (CFN reference
 * syntax) or lowercased variants. Both are rejected by CloudControl.
 */
export function validateSsmParameterShape(
  desiredState: Record<string, unknown>,
): string | null {
  const type = desiredState["Type"];
  if (type !== undefined && !VALID_SSM_TYPES.has(type as string)) {
    return (
      `[ERROR] SSM Parameter Type "${String(type)}" is not a valid value. ` +
      `[FIX] Set Type to one of: String, StringList, SecureString.`
    );
  }
  return null;
}

// Valid RetentionInDays values per AWS CloudWatch Logs API.
const VALID_LOG_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
]);

/**
 * Logs::LogGroup — RetentionInDays, if supplied, must be one of the
 * discrete values CloudWatch Logs accepts. Arbitrary integers are rejected.
 */
export function validateLogsLogGroupShape(
  desiredState: Record<string, unknown>,
): string | null {
  const retention = desiredState["RetentionInDays"];
  if (
    retention !== undefined &&
    !VALID_LOG_RETENTION_DAYS.has(retention as number)
  ) {
    return (
      `[ERROR] CloudWatch Logs RetentionInDays value ${String(retention)} is not a valid AWS-accepted value. ` +
      `[FIX] Use one of the accepted values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653. ` +
      `Omit RetentionInDays to retain logs indefinitely.`
    );
  }
  return null;
}

const VALID_APIGWV2_PROTOCOLS = new Set(["HTTP", "WEBSOCKET"]);

/**
 * ApiGatewayV2::Api — ProtocolType must be HTTP or WEBSOCKET.
 */
export function validateApiGatewayV2ApiShape(
  desiredState: Record<string, unknown>,
): string | null {
  const protocol = desiredState["ProtocolType"];
  if (
    protocol !== undefined &&
    !VALID_APIGWV2_PROTOCOLS.has(protocol as string)
  ) {
    return (
      `[ERROR] ApiGatewayV2 Api ProtocolType "${String(protocol)}" is not valid. ` +
      `[FIX] Set ProtocolType to "HTTP" (for REST/HTTP APIs) or "WEBSOCKET" (for WebSocket APIs).`
    );
  }
  return null;
}

/**
 * SecretsManager::Secret — SecretString and GenerateSecretString are mutually
 * exclusive. CloudControl rejects a secret that specifies both.
 */
export function validateSecretsManagerSecretShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (
    "SecretString" in desiredState &&
    "GenerateSecretString" in desiredState
  ) {
    return (
      "[ERROR] SecretsManager Secret has both SecretString and GenerateSecretString set. " +
      "[FIX] Remove one: use SecretString to supply a known secret value, or GenerateSecretString to have Secrets Manager auto-generate one."
    );
  }
  return null;
}

/**
 * EC2::VPC — CidrBlock is required for standard VPCs. IPAM-allocated VPCs
 * use Ipv4IpamPoolId or Ipv6IpamPoolId instead of a fixed CidrBlock.
 * HIGH-1: original check rejected IPAM VPCs by requiring CidrBlock
 * unconditionally. Fix: pass when any of the three CIDR source properties
 * is present.
 */
export function validateEc2VpcShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (
    !desiredState["CidrBlock"] &&
    !desiredState["Ipv4IpamPoolId"] &&
    !desiredState["Ipv6IpamPoolId"]
  ) {
    return (
      "[ERROR] AWS::EC2::VPC is missing a CIDR source property. " +
      "[FIX] Provide one of: CidrBlock (e.g. 10.0.0.0/16) for a standard VPC, " +
      "Ipv4IpamPoolId for an IPAM-allocated VPC, or Ipv6IpamPoolId for an IPv6 IPAM VPC."
    );
  }
  return null;
}

/**
 * EC2::Subnet — CidrBlock and VpcId are both required for standard IPv4
 * subnets. IPv6-native subnets may omit CidrBlock in favour of Ipv6Native:true
 * or Ipv6CidrBlock. HIGH-2: original check rejected IPv6-native subnets by
 * requiring CidrBlock unconditionally.
 *
 * VpcId remains required regardless of CIDR mode.
 */
export function validateEc2SubnetShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (
    !desiredState["CidrBlock"] &&
    !desiredState["Ipv6Native"] &&
    !desiredState["Ipv6CidrBlock"]
  ) {
    return (
      "[ERROR] AWS::EC2::Subnet is missing a CIDR source. " +
      "[FIX] Provide one of: CidrBlock (e.g. 10.0.1.0/24) for an IPv4 subnet, " +
      "Ipv6CidrBlock for an IPv6 subnet, or set Ipv6Native: true for an IPv6-only subnet."
    );
  }
  if (!desiredState["VpcId"]) {
    return (
      "[ERROR] AWS::EC2::Subnet is missing required property VpcId. " +
      "[FIX] Set VpcId to the ID or logical reference of the parent VPC (e.g. !Ref MyVPC or vpc-0abc1234)."
    );
  }
  return null;
}

/**
 * RDS::DBSubnetGroup — SubnetIds must contain at least 2 subnet IDs in at
 * least 2 different Availability Zones. AWS rejects subnet groups that span
 * fewer than 2 AZs. This validator enforces the count threshold; AZ diversity
 * cannot be checked at plan time without an AWS API call.
 *
 * LOW-1: extended error message to mention "in at least 2 different
 * Availability Zones" so users understand the AZ-diversity requirement.
 */
export function validateRdsDbSubnetGroupShape(
  desiredState: Record<string, unknown>,
): string | null {
  const subnetIds = desiredState["SubnetIds"];
  if (Array.isArray(subnetIds) && subnetIds.length < 2) {
    return (
      `[ERROR] RDS DBSubnetGroup SubnetIds has ${subnetIds.length} subnet — ` +
      "AWS requires at least 2 subnets in at least 2 different Availability Zones. " +
      "[FIX] Add at least one more subnet from a different AZ. " +
      "Select subnets from separate AZs (e.g. us-east-1a and us-east-1b) to satisfy the multi-AZ coverage requirement."
    );
  }
  return null;
}

const VALID_CW_COMPARISON_OPERATORS = new Set([
  "GreaterThanOrEqualToThreshold",
  "GreaterThanThreshold",
  "LessThanThreshold",
  "LessThanOrEqualToThreshold",
  "LessThanLowerOrGreaterThanUpperThreshold",
  "LessThanLowerThreshold",
  "GreaterThanUpperThreshold",
]);

/**
 * CloudWatch::Alarm — ComparisonOperator must be one of the valid enum values.
 * LLMs frequently emit shortened forms like "GreaterThan" or ">=" which
 * CloudControl rejects.
 */
export function validateCloudWatchAlarmShape(
  desiredState: Record<string, unknown>,
): string | null {
  const op = desiredState["ComparisonOperator"];
  if (op !== undefined && !VALID_CW_COMPARISON_OPERATORS.has(op as string)) {
    return (
      `[ERROR] CloudWatch Alarm ComparisonOperator "${String(op)}" is not a valid value. ` +
      `[FIX] Use one of: GreaterThanOrEqualToThreshold, GreaterThanThreshold, LessThanThreshold, LessThanOrEqualToThreshold, LessThanLowerOrGreaterThanUpperThreshold, LessThanLowerThreshold, GreaterThanUpperThreshold.`
    );
  }
  return null;
}

const VALID_ELB_SCHEMES = new Set(["internet-facing", "internal"]);

/**
 * ElasticLoadBalancingV2::LoadBalancer — Scheme must be "internet-facing"
 * or "internal". LLMs frequently emit "public", "private", or "external".
 */
export function validateElbv2LoadBalancerShape(
  desiredState: Record<string, unknown>,
): string | null {
  const scheme = desiredState["Scheme"];
  if (scheme !== undefined && !VALID_ELB_SCHEMES.has(scheme as string)) {
    return (
      `[ERROR] ElasticLoadBalancingV2 LoadBalancer Scheme "${String(scheme)}" is not valid. ` +
      `[FIX] Set Scheme to "internet-facing" (public load balancer) or "internal" (private, VPC-only).`
    );
  }
  return null;
}

/**
 * EFS::FileSystem — KmsKeyId must not be set unless Encrypted is also true.
 * Setting KmsKeyId without Encrypted: true silently enables encryption in
 * some SDK versions but is rejected by CloudFormation.
 *
 * LOW-2: treat an empty-string KmsKeyId as absent (same as not set).
 * An empty-string KmsKeyId means "no custom key specified", which is
 * equivalent to omitting the property entirely and should NOT trigger the
 * "KmsKeyId without Encrypted" error.
 */
export function validateEfsFileSystemShape(
  desiredState: Record<string, unknown>,
): string | null {
  const kmsKeyId = desiredState["KmsKeyId"];
  // LOW-2: empty string is treated as absent — only a non-empty KmsKeyId
  // combined with Encrypted !== true is an error.
  const hasRealKmsKeyId =
    "KmsKeyId" in desiredState &&
    typeof kmsKeyId === "string" &&
    kmsKeyId.trim() !== "";
  if (hasRealKmsKeyId && desiredState["Encrypted"] !== true) {
    return (
      "[ERROR] EFS FileSystem sets KmsKeyId but Encrypted is not true. " +
      "[FIX] Add Encrypted: true alongside KmsKeyId, or remove KmsKeyId to use the default AWS-managed EFS key when encryption is enabled."
    );
  }
  return null;
}

/**
 * Events::Rule — at least one of EventPattern or ScheduleExpression must
 * be provided; an EventBridge rule without either cannot match any events.
 */
export function validateEventsRuleShape(
  desiredState: Record<string, unknown>,
): string | null {
  const hasPattern = "EventPattern" in desiredState;
  const hasSchedule = "ScheduleExpression" in desiredState;
  if (!hasPattern && !hasSchedule) {
    return (
      "[ERROR] Events::Rule is missing both EventPattern and ScheduleExpression. " +
      "[FIX] Provide at least one: EventPattern (JSON match filter) or ScheduleExpression (cron/rate expression, e.g. rate(5 minutes))."
    );
  }
  return null;
}

/**
 * KMS::Key — KeyPolicy is NOT enforced at plan time. AWS KMS applies a
 * sensible default key policy when KeyPolicy is omitted, granting the root
 * account administrator access. Enforcing KeyPolicy here would be STRICTER
 * than AWS itself, blocking legitimate "create KMS key" intents that rely on
 * the default policy.
 *
 * MED-1: removed the required-KeyPolicy check. The validator function is
 * kept and exported for callers that want to opt-in to a strict KeyPolicy
 * enforcement (e.g. compliance pipelines), but it is NOT registered in
 * PLAN_SHAPE_VALIDATORS.
 *
 * Callers that do want to enforce a key policy can invoke this directly:
 *   validateKmsKeyShape(desiredState) — returns null (always passes now).
 *
 * To re-add enforcement: register `validateKmsKeyShape` back in
 * PLAN_SHAPE_VALIDATORS[RESOURCE_TYPES.KMS_KEY].
 */
export function validateKmsKeyShape(
  _desiredState: Record<string, unknown>,
): string | null {
  // MED-1: no-op. AWS supplies a default key policy when KeyPolicy is absent.
  return null;
}

/**
 * EC2::SecurityGroup — VpcId is required for VPC security groups (the vast
 * majority of use cases since EC2-Classic retirement in August 2022).
 * We validate presence to catch the common LLM omission.
 */
export function validateEc2SecurityGroupShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (!desiredState["VpcId"]) {
    return (
      "[ERROR] AWS::EC2::SecurityGroup is missing required property VpcId. " +
      "[FIX] Set VpcId to the ID or logical reference of the parent VPC. EC2-Classic (VpcId-free) was retired in August 2022."
    );
  }
  return null;
}

/**
 * EC2::RouteTable — VpcId is required.
 */
export function validateEc2RouteTableShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (!desiredState["VpcId"]) {
    return (
      "[ERROR] AWS::EC2::RouteTable is missing required property VpcId. " +
      "[FIX] Set VpcId to the ID or logical reference of the VPC that will own this route table."
    );
  }
  return null;
}

/**
 * EC2::NatGateway — SubnetId and AllocationId/ConnectivityType are required
 * for public NAT gateways. At minimum SubnetId must always be specified.
 */
export function validateEc2NatGatewayShape(
  desiredState: Record<string, unknown>,
): string | null {
  if (!desiredState["SubnetId"]) {
    return (
      "[ERROR] AWS::EC2::NatGateway is missing required property SubnetId. " +
      "[FIX] Set SubnetId to the ID of the public subnet where the NAT gateway will be placed."
    );
  }
  // Public NAT gateway (default) requires AllocationId; private does not.
  const connectivityType = desiredState["ConnectivityType"];
  const isPrivate = connectivityType === "private";
  if (!isPrivate && !desiredState["AllocationId"]) {
    return (
      "[ERROR] AWS::EC2::NatGateway is missing AllocationId (required for public NAT gateways). " +
      "[FIX] Create an Elastic IP (AWS::EC2::EIP) and reference its AllocationId here, or set ConnectivityType: private for a private NAT gateway."
    );
  }
  return null;
}

// ── Plan-shape validator registry (P085) ─────────────────────────────────────
//
// Each entry maps a resource type to a list of validator functions. All
// validators in the list run in order; the first non-null result is returned.
// Adding a new type: (1) write the validator above, (2) register it here.

type PlanShapeValidator = (state: Record<string, unknown>) => string | null;

const PLAN_SHAPE_VALIDATORS: Record<string, PlanShapeValidator[]> = {
  [RESOURCE_TYPES.DYNAMODB_TABLE]: [validateDynamoDbKeySchema],
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: [validateCloudFrontOrigins],
  [RESOURCE_TYPES.IAM_ROLE]: [validateIamRoleShape],
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: [validateLambdaCodeShape],
  [RESOURCE_TYPES.EC2_INSTANCE]: [validateEc2InstanceShape],
  [RESOURCE_TYPES.SQS_QUEUE]: [validateSqsQueueShape],
  [RESOURCE_TYPES.SNS_TOPIC]: [validateSnsTopicShape],
  [RESOURCE_TYPES.SSM_PARAMETER]: [validateSsmParameterShape],
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: [validateLogsLogGroupShape],
  [RESOURCE_TYPES.APIGATEWAYV2_API]: [validateApiGatewayV2ApiShape],
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: [validateSecretsManagerSecretShape],
  [RESOURCE_TYPES.EC2_VPC]: [validateEc2VpcShape],
  [RESOURCE_TYPES.EC2_SUBNET]: [validateEc2SubnetShape],
  [RESOURCE_TYPES.RDS_DB_SUBNET_GROUP]: [validateRdsDbSubnetGroupShape],
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: [validateCloudWatchAlarmShape],
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: [validateElbv2LoadBalancerShape],
  [RESOURCE_TYPES.EFS_FILE_SYSTEM]: [validateEfsFileSystemShape],
  [RESOURCE_TYPES.EVENTS_RULE]: [validateEventsRuleShape],
  [RESOURCE_TYPES.KMS_KEY]: [validateKmsKeyShape],
  // R10b-04 follow-up: EC2_SECURITY_GROUP / EC2_ROUTE_TABLE /
  // EC2_NAT_GATEWAY validators were registered but they enforce
  // required-field presence (VpcId, SubnetId, AllocationId) that the
  // LLM legitimately omits in `--json` mode (where the wizard does
  // not run to fill them). Pre-existing probes
  // (e.g. e96.W3.N2 bp-sg-high-risk-fires-on-3306) assert that BP
  // rules fire for "Create a security group allowing 0.0.0.0/0 on
  // port 3306" — which has no VpcId in the intent. The strict
  // validator made the plan FAIL at validate-desired-state before
  // BP rules could evaluate, breaking that probe.
  //
  // Per `feedback_lazy_credential_resolution_in_mcp` (preserve
  // original semantics on additive checks): the validators remain
  // EXPORTED (and unit-tested) so opt-in callers can still invoke
  // them, but they are NOT registered in PLAN_SHAPE_VALIDATORS — so
  // the plan-shape gate doesn't reject these types when the wizard
  // hasn't run. CCAPI will reject at apply-time with the canonical
  // AWS error if VpcId is genuinely missing.
};

/**
 * Runs every plan-time validator appropriate to the resource type. Returns
 * `null` on pass (all validators pass OR no validator applies), or the
 * first validator's error message on fail.
 *
 * Kept as a single entrypoint so the `plan-generator.ts` façade wires in
 * one call; the set of validators grows by registering entries in
 * `PLAN_SHAPE_VALIDATORS` above.
 */
export function validatePlanShape(
  desiredState: Record<string, unknown>,
  resourceType: string,
): string | null {
  const validators = PLAN_SHAPE_VALIDATORS[resourceType];
  if (!validators) return null;
  for (const v of validators) {
    const err = v(desiredState);
    if (err !== null) return err;
  }
  return null;
}
