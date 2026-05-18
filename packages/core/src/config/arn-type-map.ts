/**
 * ARN-to-CloudFormation type mapping — single source of truth.
 *
 * Maps AWS service names (from ARN partition) to CloudFormation resource type
 * strings. Used by both CLI and MCP server for listing and resolving resources.
 *
 * @see Story 42.10 — zero magic strings policy
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
} from "./resource-types.js";
import { AWS_SERVICE_EXECUTE_API } from "./cfn-keys.js";

/**
 * Simple service-name to CFN type map for services with a single resource type.
 * Key: service name from ARN (e.g. "s3", "lambda").
 */
export const SERVICE_TYPE_MAP: Readonly<Record<string, string>> = {
  s3: RESOURCE_TYPES.S3_BUCKET,
  // NOTE: `rds` deliberately absent from SERVICE_TYPE_MAP — resolved
  // via SERVICE_SUBTYPE_MAP["rds"] below, which dispatches on the
  // resource segment (db / subgrp). See Story e94.P1.
  dynamodb: RESOURCE_TYPES.DYNAMODB_TABLE,
  sqs: RESOURCE_TYPES.SQS_QUEUE,
  sns: RESOURCE_TYPES.SNS_TOPIC,
  // A1 — EFS (service name is "elasticfilesystem", not "efs")
  elasticfilesystem: RESOURCE_TYPES.EFS_FILE_SYSTEM,
  cloudformation: LIST_RESOURCE_TYPES.CLOUDFORMATION_STACK,
  logs: RESOURCE_TYPES.LOGS_LOG_GROUP,
  // NOTE: `events` deliberately absent from SERVICE_TYPE_MAP — it's
  // resolved via SERVICE_SUBTYPE_MAP["events"] below, which dispatches
  // on the resource segment (rule / event-bus / connection /
  // api-destination). See Story e92.1.b-followup.
  cloudfront: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  ecs: RESOURCE_TYPES.ECS_CLUSTER,
  eks: LIST_RESOURCE_TYPES.EKS_CLUSTER,
  elasticache: LIST_RESOURCE_TYPES.ELASTICACHE_CACHE_CLUSTER,
  kinesis: LIST_RESOURCE_TYPES.KINESIS_STREAM,
  secretsmanager: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  // KMS must be explicitly mapped — the fallback path at line 123
  // would emit "AWS::Kms::Key" (title-case) which CCAPI rejects with
  // "The type 'AWS::Kms::Key' cannot be found." Live-AWS 2026-04-14.
  kms: RESOURCE_TYPES.KMS_KEY,
  stepfunctions: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
  states: LIST_RESOURCE_TYPES.STEPFUNCTIONS_STATE_MACHINE,
} as const;

/**
 * Services with multiple resource types — resolved by ARN resource segment.
 * Key: service name, Value: map of resource-segment to CFN type.
 * Empty string key ("") matches when no specific segment matches.
 */
export const SERVICE_SUBTYPE_MAP: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  ec2: {
    instance: RESOURCE_TYPES.EC2_INSTANCE,
    vpc: RESOURCE_TYPES.EC2_VPC,
    subnet: RESOURCE_TYPES.EC2_SUBNET,
    "security-group": RESOURCE_TYPES.EC2_SECURITY_GROUP,
    "internet-gateway": RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    "route-table": RESOURCE_TYPES.EC2_ROUTE_TABLE,
    natgateway: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    "elastic-ip": COMPANION_RESOURCE_TYPES.EC2_EIP,
  },
  iam: {
    role: RESOURCE_TYPES.IAM_ROLE,
    policy: LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY,
    user: LIST_RESOURCE_TYPES.IAM_USER,
    group: LIST_RESOURCE_TYPES.IAM_GROUP,
    "instance-profile": LIST_RESOURCE_TYPES.IAM_INSTANCE_PROFILE,
  },
  apigateway: {
    "/apis": RESOURCE_TYPES.APIGATEWAYV2_API,
    restapis: LIST_RESOURCE_TYPES.APIGATEWAY_REST_API,
  },
  [AWS_SERVICE_EXECUTE_API]: {
    "": RESOURCE_TYPES.APIGATEWAYV2_API,
  },
  elasticloadbalancing: {
    loadbalancer: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    targetgroup: LIST_RESOURCE_TYPES.ELBV2_TARGET_GROUP,
  },
  ecr: {
    repository: RESOURCE_TYPES.ECR_REPOSITORY,
  },
  cloudwatch: {
    alarm: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  },
  ssm: {
    parameter: RESOURCE_TYPES.SSM_PARAMETER,
  },
  lambda: {
    "event-source-mapping": LIST_RESOURCE_TYPES.LAMBDA_EVENT_SOURCE_MAPPING,
    "": RESOURCE_TYPES.LAMBDA_FUNCTION,
  },
  // Story e92.1.b-followup — dispatch Events ARNs to the correct CFN
  // type by resource segment. Prior to this split, SERVICE_TYPE_MAP
  // forced every Events ARN (EventBus, Connection, ApiDestination) to
  // classify as AWS::Events::Rule, breaking `assignee admin list` and every
  // other arn-type-map consumer. Wave-1 e92.1.b put a targeted
  // DeleteEventBus bypass in `destroy.ts`; this follow-up is the
  // root-cause classifier fix.
  //
  // Fallback ("" key) preserves the pre-split default of
  // AWS::Events::Rule so unparseable / future Events resource segments
  // do not crash (no change in behaviour for those cases).
  events: {
    rule: RESOURCE_TYPES.EVENTS_RULE,
    "event-bus": RESOURCE_TYPES.EVENTS_EVENT_BUS,
    connection: RESOURCE_TYPES.EVENTS_CONNECTION,
    "api-destination": RESOURCE_TYPES.EVENTS_API_DESTINATION,
    "": RESOURCE_TYPES.EVENTS_RULE,
  },
  // Story e94.P1 (D-03) — dispatch RDS ARNs to the correct CFN type
  // by resource segment. Prior to this split, SERVICE_TYPE_MAP forced
  // every RDS ARN to classify as AWS::RDS::DBInstance, misclassifying
  // DBSubnetGroup, DBParameterGroup, DBSnapshot, DBCluster, etc. in
  // `assignee admin list`, provision-record classification, and every other
  // arn-type-map consumer.
  //
  // Canonical RDS ARN shapes (AWS ARN reference):
  //   DBInstance        arn:<p>:rds:<r>:<a>:db:<name>
  //   DBSubnetGroup     arn:<p>:rds:<r>:<a>:subgrp:<name>
  //   DBSecurityGroup   arn:<p>:rds:<r>:<a>:secgrp:<name>         (EC2-Classic legacy)
  //   DBParameterGroup  arn:<p>:rds:<r>:<a>:pg:<name>
  //   DBSnapshot        arn:<p>:rds:<r>:<a>:snapshot:<name>
  //   DBCluster         arn:<p>:rds:<r>:<a>:cluster:<name>
  //   DBClusterSnapshot arn:<p>:rds:<r>:<a>:cluster-snapshot:<name>
  //   OptionGroup       arn:<p>:rds:<r>:<a>:og:<name>
  //
  // The `secgrp`, `pg`, `snapshot`, `cluster-snapshot`, `og` mappings
  // use literal CFN type strings because those subtypes are not (yet)
  // in the `RESOURCE_TYPES` registry — we do not currently create /
  // destroy them as first-class resources. This is a classification-
  // only fix: a misclassified ARN in `assignee admin list` is the D-03 bug;
  // promoting any of these to provisionable types is a separate
  // future epic.
  //
  // Fallback ("" key) preserves the pre-split default of
  // AWS::RDS::DBInstance so unparseable / future RDS resource segments
  // do not crash (no change in behaviour for those cases).
  rds: {
    db: RESOURCE_TYPES.RDS_DB_INSTANCE,
    subgrp: RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
    secgrp: "AWS::RDS::DBSecurityGroup",
    pg: "AWS::RDS::DBParameterGroup",
    snapshot: "AWS::RDS::DBSnapshot",
    cluster: "AWS::RDS::DBCluster",
    "cluster-snapshot": "AWS::RDS::DBClusterSnapshot",
    og: "AWS::RDS::OptionGroup",
    "": RESOURCE_TYPES.RDS_DB_INSTANCE,
  },
} as const;

/**
 * Services whose correct CloudFormation type CANNOT be derived from
 * `service.charAt(0).toUpperCase() + service.slice(1)`. The one-line
 * fallback below would produce e.g. `AWS::Kms::Key` (wrong) instead
 * of `AWS::KMS::Key` (correct). These need explicit capitalization.
 *
 * Epic 47 edge-hunter H1 call-out: the KMS fix in c269379 only
 * patched the single case that surfaced in live-AWS runs; the
 * structural bug still affected IoT, FSx, WAFv2, CodeBuild,
 * CodePipeline, MediaConvert, etc. Listing every known miscapitalized
 * AWS service keeps the fallback path safe for those too.
 *
 * When a new service appears in production traffic that isn't here,
 * the fallback path will produce a wrong-cased type and CCAPI will
 * reject it — that's visible failure, not silent data loss. Add
 * the entry here with the correct casing.
 */
const SERVICE_CASING_OVERRIDES: Readonly<Record<string, string>> = {
  kms: "KMS",
  iot: "IoT",
  fsx: "FSx",
  wafv2: "WAFv2",
  waf: "WAF",
  ram: "RAM",
  sqs: "SQS",
  sns: "SNS",
  sts: "STS",
  vpc: "VPC",
  ssm: "SSM",
  ses: "SES",
  mq: "AmazonMQ",
  ec2: "EC2",
  ecs: "ECS",
  eks: "EKS",
  ecr: "ECR",
  rds: "RDS",
  iam: "IAM",
  s3: "S3",
  codebuild: "CodeBuild",
  codecommit: "CodeCommit",
  codedeploy: "CodeDeploy",
  codepipeline: "CodePipeline",
  mediaconvert: "MediaConvert",
  medialive: "MediaLive",
  mediapackage: "MediaPackage",
  mediastore: "MediaStore",
  appstream: "AppStream",
  apprunner: "AppRunner",
  appmesh: "AppMesh",
  appconfig: "AppConfig",
  appsync: "AppSync",
  elasticbeanstalk: "ElasticBeanstalk",
  elastictranscoder: "ElasticTranscoder",
  stepfunctions: "StepFunctions",
  secretsmanager: "SecretsManager",
  cloudwatch: "CloudWatch",
  cloudfront: "CloudFront",
  cloudformation: "CloudFormation",
  cloudtrail: "CloudTrail",
  dynamodb: "DynamoDB",
  apigateway: "ApiGateway",
  apigatewayv2: "ApiGatewayV2",
};

/**
 * AWS services whose control plane is GLOBAL — ARNs for these services
 * have an empty region segment (`arn:aws:iam::<acct>:role/...`) and
 * are not region-scoped.
 *
 * Story e94.P2 (D-06): the RGTA-driven listing path previously stamped
 * the operator's configured region on every IAM ARN because the parse
 * layer returned `""` for the empty region slot and the call site's
 * `parsed.region || region` fallback leaked the operator default to
 * display. Consumers should call `isGlobalService` at display time to
 * substitute `"global"` instead.
 *
 * Scope:
 * - `iam` — roles, policies, users, groups, instance-profiles.
 * - `cloudfront` — distributions, OACs, cache policies.
 * - `route53` — hosted zones (record sets are per-zone, not regional).
 * - `waf` — global-only, classic WAF and WAFv2 CloudFront scope.
 * - `organizations` — AWS Organizations is global-only.
 *
 * `s3` is deliberately EXCLUDED from this set. S3 buckets are
 * technically regional (the bucket lives in one region) even though
 * the ARN has no region segment; the existing display fallback to the
 * operator-default region stays correct for S3.
 */
export const GLOBAL_SERVICES: ReadonlySet<string> = new Set([
  "iam",
  "cloudfront",
  "route53",
  "waf",
  "organizations",
]);

/**
 * Returns `true` when an ARN's service slot names a globally-scoped
 * AWS control plane. Used by display helpers to stamp
 * `region: "global"` on IAM / CloudFront / etc. ARNs instead of
 * leaking the operator's configured region.
 *
 * @param service - AWS service name from ARN slot 2 (e.g. `iam`,
 *                  `cloudfront`). Lowercased comparison matches
 *                  RGTA output shape.
 */
export function isGlobalService(service: string): boolean {
  return GLOBAL_SERVICES.has(service);
}

/**
 * Converts an AWS service name and resource component from an ARN
 * into a CloudFormation-style type string.
 *
 * @param service - AWS service name from ARN (e.g. "s3", "ec2")
 * @param resourcePart - Resource section of the ARN (everything after the 5th colon)
 * @returns CloudFormation resource type string (e.g. "AWS::S3::Bucket")
 */
export function arnToCloudFormationType(
  service: string,
  resourcePart: string,
): string {
  // Check subtype map first (for services with multiple resource types)
  const subtypes = SERVICE_SUBTYPE_MAP[service];
  if (subtypes) {
    const segments = resourcePart.split(/[:/]/).filter(Boolean);
    const resourceSeg = segments[0] ?? "";
    if (resourcePart.startsWith("/")) {
      const prefixed = "/" + resourceSeg;
      if (subtypes[prefixed]) return subtypes[prefixed]!;
    }
    if (subtypes[resourceSeg]) return subtypes[resourceSeg]!;
    if (subtypes[""]) return subtypes[""]!;
  }

  // Simple service→type map
  const mapped = SERVICE_TYPE_MAP[service];
  if (mapped) return mapped;

  // Fallback: construct from service + resource. Use the explicit
  // casing override table when available — `service.charAt(0).
  // toUpperCase()` would emit `AWS::Kms::Key` / `AWS::Iot::Thing` /
  // etc., which CCAPI rejects. Epic 47 edge-hunter H1.
  const capitalizedService =
    SERVICE_CASING_OVERRIDES[service] ??
    service.charAt(0).toUpperCase() + service.slice(1);
  const resourceType = resourcePart.split(/[:/]/)[0] ?? "Resource";
  const capitalizedResource =
    resourceType.charAt(0).toUpperCase() + resourceType.slice(1);

  return `AWS::${capitalizedService}::${capitalizedResource}`;
}
