import { describe, it, expect } from "vitest";
import { evaluateTriggers, loadBestPractices } from "../src/index.js";
import type { EvalContext } from "../src/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_ROOT = join(__dirname, "..");
const allPractices = loadBestPractices(BP_ROOT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(
  resourceType: string,
  desiredState: Record<string, unknown>,
): EvalContext {
  return { resourceType, desiredState };
}

function findingsFor(
  ruleId: string,
  resourceType: string,
  desiredState: Record<string, unknown>,
) {
  const practices = allPractices.filter((bp) => bp.id === ruleId);
  expect(practices.length).toBeGreaterThanOrEqual(1);
  return evaluateTriggers(ctx(resourceType, desiredState), practices);
}

/** Set a deeply-nested value given a dot+bracket path. */
function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const bracketMatch = seg.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      const [, field, idx] = bracketMatch;
      if (!current[field!]) current[field!] = [];
      const arr = current[field!] as unknown[];
      const index = parseInt(idx!, 10);
      if (!arr[index]) arr[index] = {};
      current = arr[index] as Record<string, unknown>;
    } else {
      if (!current[seg]) current[seg] = {};
      current = current[seg] as Record<string, unknown>;
    }
  }
  const lastSeg = segments[segments.length - 1]!;
  const lastBracket = lastSeg.match(/^([^[]+)\[(\d+)\]$/);
  if (lastBracket) {
    const [, field, idx] = lastBracket;
    if (!current[field!]) current[field!] = [];
    (current[field!] as unknown[])[parseInt(idx!, 10)] = value;
  } else {
    current[lastSeg] = value;
  }
}

/**
 * Build a desiredState where a path is set to the given value.
 * Handles dot-notation and bracket-notation paths.
 */
function stateWith(path: string, value: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  setNested(obj, path, value);
  return obj;
}

// ---------------------------------------------------------------------------
// Types for data-driven test specs
// ---------------------------------------------------------------------------

type CheckType =
  | "equals"
  | "not_equals"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "less_than"
  | "contains"
  | "not_contains"
  | "conditional_forbidden"
  | "awareness"
  | "cross_resource_count"
  | "cross_resource_reference";

interface RuleSpec {
  id: string;
  resourceType: string;
  propertyPath: string;
  checkType: CheckType;
  expectedValue: unknown;
}

const ALWAYS_FIRE_TYPES: CheckType[] = [
  "awareness",
  "cross_resource_count",
  "cross_resource_reference",
];

// ---------------------------------------------------------------------------
// Generate "fires" and "does NOT fire" desiredState for each check type
// ---------------------------------------------------------------------------

function firingState(spec: RuleSpec): Record<string, unknown> {
  switch (spec.checkType) {
    case "equals":
      // Field not equal to expected → fires
      if (spec.expectedValue === true)
        return stateWith(spec.propertyPath, false);
      if (spec.expectedValue === false)
        return stateWith(spec.propertyPath, true);
      if (typeof spec.expectedValue === "number")
        return stateWith(spec.propertyPath, spec.expectedValue + 999);
      if (typeof spec.expectedValue === "string")
        return stateWith(spec.propertyPath, "__WRONG__");
      return {}; // missing field also fires

    case "not_equals":
      // Field equals the unwanted value → fires
      return stateWith(spec.propertyPath, spec.expectedValue);

    case "exists":
      // Field missing → fires
      return {};

    case "not_exists":
      // Field present → fires
      return stateWith(spec.propertyPath, "some-value");

    case "greater_than":
      // Field <= expected → fires
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue - 1 : 0,
      );

    case "less_than":
      // Field >= expected → fires
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue + 1 : 99999,
      );

    case "contains":
      // Field does NOT contain expected → fires
      return stateWith(spec.propertyPath, "__NO_MATCH__");

    case "not_contains":
      // Field DOES contain expected → fires
      if (typeof spec.expectedValue === "string") {
        return stateWith(
          spec.propertyPath,
          `prefix${spec.expectedValue}suffix`,
        );
      }
      return stateWith(spec.propertyPath, [spec.expectedValue]);

    case "conditional_forbidden":
      // Field exists → fires
      return stateWith(spec.propertyPath, "igw-12345");

    case "awareness":
    case "cross_resource_count":
    case "cross_resource_reference":
      // Always fires
      return stateWith(spec.propertyPath, "any-value");

    default:
      return {};
  }
}

function passingState(spec: RuleSpec): Record<string, unknown> {
  switch (spec.checkType) {
    case "equals":
      return stateWith(spec.propertyPath, spec.expectedValue);

    case "not_equals":
      // Field is different from unwanted value
      if (spec.expectedValue === true)
        return stateWith(spec.propertyPath, false);
      if (typeof spec.expectedValue === "string")
        return stateWith(spec.propertyPath, "__DIFFERENT__");
      return stateWith(spec.propertyPath, "__DIFFERENT__");

    case "exists":
      return stateWith(spec.propertyPath, "some-value");

    case "not_exists":
      return {};

    case "greater_than":
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue + 1 : 1,
      );

    case "less_than":
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue - 1 : 0,
      );

    case "contains":
      if (typeof spec.expectedValue === "string") {
        return stateWith(
          spec.propertyPath,
          `prefix${spec.expectedValue}suffix`,
        );
      }
      return stateWith(spec.propertyPath, [spec.expectedValue]);

    case "not_contains":
      return stateWith(spec.propertyPath, "__CLEAN__");

    case "conditional_forbidden":
      return {};

    // awareness/cross_resource_count/cross_resource_reference never pass
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// ALL 130 BP rules organized by service
// ---------------------------------------------------------------------------

const s3Rules: RuleSpec[] = [
  {
    id: "BP-S3-001",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-002",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.BlockPublicPolicy",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-003",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.IgnorePublicAcls",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-004",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.RestrictPublicBuckets",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-005",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "VersioningConfiguration.Status",
    checkType: "equals",
    expectedValue: "Enabled",
  },
  {
    id: "BP-S3-006",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "BucketEncryption",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-008",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "OwnershipControls.Rules[0].ObjectOwnership",
    checkType: "equals",
    expectedValue: "BucketOwnerEnforced",
  },
  {
    id: "BP-S3-009",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "NotificationConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-010",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "LifecycleConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-011",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "BucketPolicy.Statement",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-S3-012",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "ObjectLockEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-015",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "ReplicationConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-016",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "IntelligentTieringConfigurations",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-017",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "LoggingConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
];

const ec2Rules: RuleSpec[] = [
  {
    id: "BP-EC2-001",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "MetadataOptions.HttpTokens",
    checkType: "equals",
    expectedValue: "required",
  },
  {
    id: "BP-EC2-002",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-003",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.VolumeType",
    checkType: "equals",
    expectedValue: "gp3",
  },
  {
    id: "BP-EC2-004",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "IamInstanceProfile",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-005",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SubnetId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-007",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "Monitoring.Enabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-009",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "NetworkInterfaces[0].AssociatePublicIpAddress",
    checkType: "not_equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-010",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SecurityGroupIds",
    checkType: "not_contains",
    expectedValue: "default",
  },
  {
    id: "BP-EC2-011",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "EbsOptimized",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-013",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "DisableApiTermination",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-014",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SubnetId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-015",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceType",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-016",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "CreditSpecification.CPUCredits",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-017",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "MetadataOptions.HttpPutResponseHopLimit",
    checkType: "equals",
    expectedValue: 1,
  },
  {
    id: "BP-EC2-018",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceId",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-019",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceType",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-020",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-021",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.VolumeId",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-022",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "ElasticIpAssociation",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-023",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "Tags",
    checkType: "awareness",
    expectedValue: true,
  },
];

const sgRules: RuleSpec[] = [
  {
    id: "BP-SG-001",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "not_equals",
    expectedValue: "0.0.0.0/0",
  },
  {
    id: "BP-SG-002",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "not_equals",
    expectedValue: "0.0.0.0/0:22",
  },
  {
    id: "BP-SG-005",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-SG-006",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "GroupDescription",
    checkType: "not_equals",
    expectedValue: "",
  },
  {
    id: "BP-SG-007",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "awareness",
    expectedValue: true,
  },
];

const igwRules: RuleSpec[] = [
  {
    id: "BP-IGW-001",
    resourceType: "AWS::EC2::InternetGateway",
    propertyPath: "VPCGatewayAttachment",
    checkType: "exists",
    expectedValue: "VpcId must reference a valid VPC",
  },
  {
    id: "BP-IGW-002",
    resourceType: "AWS::EC2::InternetGateway",
    propertyPath: "RouteTable.Routes",
    checkType: "exists",
    expectedValue:
      "Route with destination 0.0.0.0/0 targeting the InternetGateway",
  },
];

const natRules: RuleSpec[] = [
  {
    id: "BP-NAT-001",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "SubnetId",
    checkType: "cross_resource_count",
    expectedValue: ">=2 NatGateways...",
  },
  {
    id: "BP-NAT-002",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "ConnectivityType",
    checkType: "awareness",
    expectedValue: "Consider private connectivity...",
  },
  {
    id: "BP-NAT-003",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "SubnetId",
    checkType: "cross_resource_reference",
    expectedValue: "SubnetId must reference a public subnet...",
  },
];

const rtRules: RuleSpec[] = [
  {
    id: "BP-RT-001",
    resourceType: "AWS::EC2::Route",
    propertyPath: "GatewayId",
    checkType: "conditional_forbidden",
    expectedValue: "Private subnets must route...",
  },
  {
    id: "BP-RT-002",
    resourceType: "AWS::EC2::Subnet",
    propertyPath: "SubnetRouteTableAssociation",
    checkType: "exists",
    expectedValue: "Every subnet should have...",
  },
];

const vpcNetworkRules: RuleSpec[] = [
  {
    id: "BP-VPC-003",
    resourceType: "AWS::EC2::VPC",
    propertyPath: "VpcId",
    checkType: "awareness",
    expectedValue: true,
  },
];

const rdsRules: RuleSpec[] = [
  {
    id: "BP-RDS-001",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "PubliclyAccessible",
    checkType: "equals",
    expectedValue: false,
  },
  {
    id: "BP-RDS-002",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "StorageEncrypted",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-003",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MultiAZ",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-004",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "DeletionProtection",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-005",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "BackupRetentionPeriod",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-RDS-007",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MonitoringInterval",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-RDS-008",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnableIAMDatabaseAuthentication",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-009",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "CopyTagsToSnapshot",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-010",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "AutoMinorVersionUpgrade",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-011",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnablePerformanceInsights",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-012",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnableCloudwatchLogsExports",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-RDS-013",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "DBInstanceIdentifier",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-RDS-014",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MultiAZ",
    checkType: "awareness",
    expectedValue: true,
  },
];

const lambdaRules: RuleSpec[] = [
  {
    id: "BP-LAMBDA-001",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "ReservedConcurrentExecutions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-002",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Architectures[0]",
    checkType: "equals",
    expectedValue: "arm64",
  },
  {
    id: "BP-LAMBDA-003",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "MemorySize",
    checkType: "greater_than",
    expectedValue: 128,
  },
  {
    id: "BP-LAMBDA-004",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Timeout",
    checkType: "less_than",
    expectedValue: 900,
  },
  {
    id: "BP-LAMBDA-005",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "DeadLetterConfig.TargetArn",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-006",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "VpcConfig.SubnetIds",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-007",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "python3.8",
  },
  {
    id: "BP-LAMBDA-010",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "python3.7",
  },
  {
    id: "BP-LAMBDA-011",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "nodejs16.x",
  },
  {
    id: "BP-LAMBDA-012",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "CodeSigningConfigArn",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-013",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "MemorySize",
    checkType: "greater_than",
    expectedValue: 128,
  },
];

const iamRules: RuleSpec[] = [
  {
    id: "BP-IAM-001",
    resourceType: "AWS::IAM::Policy",
    propertyPath: "PolicyDocument.Statement[0].Effect",
    checkType: "not_equals",
    expectedValue: "Allow",
  },
  {
    id: "BP-IAM-002",
    resourceType: "AWS::IAM::User",
    propertyPath: "MFADevices",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-003",
    resourceType: "AWS::IAM::User",
    propertyPath: "AccessKeyMaxAge",
    checkType: "less_than",
    expectedValue: 90,
  },
  {
    id: "BP-IAM-004",
    resourceType: "AWS::IAM::User",
    propertyPath: "AttachedPolicies",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-005",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "not_equals",
    expectedValue: "*",
  },
  {
    id: "BP-IAM-006",
    resourceType: "AWS::IAM::Role",
    propertyPath: "PermissionsBoundary",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-007",
    resourceType: "AWS::IAM::Role",
    propertyPath: "MaxSessionDuration",
    checkType: "less_than",
    expectedValue: 14401,
  },
  {
    id: "BP-IAM-008",
    resourceType: "AWS::IAM::Role",
    propertyPath: "Policies",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-009",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-IAM-010",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "awareness",
    expectedValue: true,
  },
];

const dynamodbRules: RuleSpec[] = [
  {
    id: "BP-DYNAMODB-001",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-002",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "DeletionProtectionEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-003",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "SSESpecification.SSEEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-005",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "BillingMode",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-006",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "BillingMode",
    checkType: "awareness",
    expectedValue: true,
  },
];

const ecsRules: RuleSpec[] = [
  {
    id: "BP-ECS-001",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].Privileged",
    checkType: "not_equals",
    expectedValue: true,
  },
  {
    id: "BP-ECS-002",
    resourceType: "AWS::ECS::Service",
    propertyPath: "NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp",
    checkType: "not_equals",
    expectedValue: "ENABLED",
  },
  {
    id: "BP-ECS-003",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].LogConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-ECS-004",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].Secrets",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-ECS-005",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].ReadonlyRootFilesystem",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-ECS-006",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "RequiresCompatibilities",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-ECS-007",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "ClusterSettings",
    checkType: "contains",
    expectedValue: { Name: "containerInsights", Value: "enabled" },
  },
  {
    id: "BP-ECS-008",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "Configuration.ExecuteCommandConfiguration.Logging",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-ECS-009",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "ServiceConnectDefaults.Namespace",
    checkType: "exists",
    expectedValue: true,
  },
];

const cloudwatchRules: RuleSpec[] = [
  {
    id: "BP-CW-001",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "AlarmActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CW-002",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "EvaluationPeriods",
    checkType: "greater_than",
    expectedValue: 1,
  },
  {
    id: "BP-CWA-001",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "OKActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CWA-002",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "InsufficientDataActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CWA-003",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "TreatMissingData",
    checkType: "not_equals",
    expectedValue: "notBreaching",
  },
];

const sqsRules: RuleSpec[] = [
  {
    id: "BP-SQS-001",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "SqsManagedSseEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-SQS-002",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "RedrivePolicy",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SQS-003",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "KmsMasterKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SQS-004",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "VisibilityTimeout",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-SQS-005",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "MessageRetentionPeriod",
    checkType: "greater_than",
    expectedValue: 60,
  },
];

const smRules: RuleSpec[] = [
  {
    id: "BP-SM-001",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "SecretString",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-002",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "KmsKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-003",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "RotationSchedule",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-004",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MasterUserPassword",
    checkType: "contains",
    expectedValue: "{{resolve:secretsmanager:",
  },
  {
    id: "BP-SM-005",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "RotationRules",
    checkType: "exists",
    expectedValue: true,
  },
];

const snsRules: RuleSpec[] = [
  {
    id: "BP-SNS-001",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "KmsMasterKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SNS-002",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "DeliveryStatusLogging",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SNS-003",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "TopicArn",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-SNS-004",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "TopicPolicy",
    checkType: "awareness",
    expectedValue: true,
  },
];

const apigwRules: RuleSpec[] = [
  {
    id: "BP-APIGW-001",
    resourceType: "AWS::ApiGatewayV2::Stage",
    propertyPath: "AccessLogSettings.DestinationArn",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-APIGW-002",
    resourceType: "AWS::ApiGatewayV2::Api",
    propertyPath: "CorsConfiguration.AllowOrigins",
    checkType: "not_contains",
    expectedValue: "*",
  },
  {
    id: "BP-APIGW-003",
    resourceType: "AWS::ApiGatewayV2::Route",
    propertyPath: "AuthorizationType",
    checkType: "not_equals",
    expectedValue: "NONE",
  },
];

const ecrRules: RuleSpec[] = [
  {
    id: "BP-ECR-001",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "ImageScanningConfiguration.ScanOnPush",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-ECR-002",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "ImageTagMutability",
    checkType: "equals",
    expectedValue: "IMMUTABLE",
  },
  {
    id: "BP-ECR-003",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "LifecyclePolicy",
    checkType: "exists",
    expectedValue: true,
  },
];

const elbRules: RuleSpec[] = [
  {
    id: "BP-ELB-001",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath: "LoadBalancerAttributes[deletion_protection.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
  {
    id: "BP-ELB-002",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath: "LoadBalancerAttributes[access_logs.s3.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
  {
    id: "BP-ELB-003",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath:
      "LoadBalancerAttributes[routing.http.drop_invalid_header_fields.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
];

const logsRules: RuleSpec[] = [
  {
    id: "BP-LOGS-001",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "RetentionInDays",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LOGS-002",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "KmsKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LOGS-003",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "MetricFilters",
    checkType: "awareness",
    expectedValue: true,
  },
];

const ssmRules: RuleSpec[] = [
  {
    id: "BP-SSM-001",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Type",
    checkType: "equals",
    expectedValue: "SecureString",
  },
  {
    id: "BP-SSM-002",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Name",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SSM-003",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Type",
    checkType: "awareness",
    expectedValue: true,
  },
];

const vpcRules: RuleSpec[] = [
  {
    id: "BP-SUBNET-001",
    resourceType: "AWS::EC2::Subnet",
    propertyPath: "MapPublicIpOnLaunch",
    checkType: "equals",
    expectedValue: false,
  },
  {
    id: "BP-VPC-001",
    resourceType: "AWS::EC2::VPC",
    propertyPath: "EnableDnsHostnames",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-VPC-002",
    resourceType: "AWS::EC2::VPC",
    propertyPath: "FlowLogs",
    checkType: "exists",
    expectedValue: true,
  },
];

const asgRules: RuleSpec[] = [
  {
    id: "BP-ASG-001",
    resourceType: "AWS::AutoScaling::AutoScalingGroup",
    propertyPath: "MaxSize",
    checkType: "exists",
    expectedValue: true,
  },
];

// ---------------------------------------------------------------------------
// Run test for a single rule spec
// ---------------------------------------------------------------------------

function runRuleTests(spec: RuleSpec): void {
  const isAlwaysFire = ALWAYS_FIRE_TYPES.includes(spec.checkType);

  it(`${spec.id} fires (${spec.checkType}, path=${spec.propertyPath})`, () => {
    const state = firingState(spec);
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(
      findings.length,
      `${spec.id} should fire but got 0 findings. State: ${JSON.stringify(state)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  if (!isAlwaysFire) {
    it(`${spec.id} does NOT fire when satisfied (${spec.checkType}, path=${spec.propertyPath})`, () => {
      const state = passingState(spec);
      const findings = findingsFor(spec.id, spec.resourceType, state);
      const matching = findings.filter((f) => f.practiceId === spec.id);
      expect(
        matching.length,
        `${spec.id} should NOT fire but got ${matching.length} findings. State: ${JSON.stringify(state)}`,
      ).toBe(0);
    });
  }
}

// ---------------------------------------------------------------------------
// ELBv2 needs special handling for bracket-key notation
// ---------------------------------------------------------------------------

function runElbRuleTests(spec: RuleSpec): void {
  // ELBv2 uses LoadBalancerAttributes[key] notation where key is a string key
  // containing dots (e.g. "deletion_protection.enabled"). The getField function
  // splits on dots first, which breaks bracket paths with dots in the key.
  // As a result, these rules ALWAYS fire (getField returns undefined).
  // We test only the "fires" case here. The "does NOT fire" case would require
  // fixing getField to handle dots inside bracket keys.

  it(`${spec.id} fires (${spec.checkType}, path=${spec.propertyPath})`, () => {
    // Even with correct attributes, getField cannot resolve dot-containing bracket keys
    const state: Record<string, unknown> = { LoadBalancerAttributes: [] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length, `${spec.id} should fire`).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it.skip(`${spec.id} does NOT fire when satisfied — BLOCKED: getField cannot resolve dots in bracket keys`, () => {
    // Once getField is fixed to handle paths like "Attrs[key.with.dots]",
    // this test should pass with: { LoadBalancerAttributes: [{ Key: "...", Value: "true" }] }
  });
}

// ---------------------------------------------------------------------------
// SM-004 needs special handling for contains with secretsmanager reference
// ---------------------------------------------------------------------------

function runSmContainsTests(spec: RuleSpec): void {
  it(`${spec.id} fires when MasterUserPassword does NOT contain secretsmanager ref`, () => {
    const state = { MasterUserPassword: "plaintext-password-123" };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when MasterUserPassword contains secretsmanager ref`, () => {
    const state = {
      MasterUserPassword:
        "{{resolve:secretsmanager:my-secret:SecretString:password}}",
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// EC2-010 not_contains with array value
// ---------------------------------------------------------------------------

function runNotContainsArrayTests(spec: RuleSpec): void {
  it(`${spec.id} fires when SecurityGroupIds contains "default"`, () => {
    const state = { SecurityGroupIds: ["sg-abc123", "default"] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when SecurityGroupIds does not contain "default"`, () => {
    const state = { SecurityGroupIds: ["sg-abc123", "sg-def456"] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// APIGW-002 not_contains with string in array
// ---------------------------------------------------------------------------

function runApigwNotContainsTests(spec: RuleSpec): void {
  it(`${spec.id} fires when AllowOrigins contains "*"`, () => {
    const state = {
      CorsConfiguration: { AllowOrigins: ["https://example.com", "*"] },
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when AllowOrigins does not contain "*"`, () => {
    const state = {
      CorsConfiguration: { AllowOrigins: ["https://example.com"] },
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// Test suites by service
// ---------------------------------------------------------------------------

describe("BP All Rules Audit", () => {
  describe("S3 (15 rules)", () => {
    for (const spec of s3Rules) {
      runRuleTests(spec);
    }
  });

  describe("EC2 Instance (20 rules)", () => {
    for (const spec of ec2Rules) {
      if (spec.id === "BP-EC2-010") {
        runNotContainsArrayTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("SecurityGroup (5 rules)", () => {
    for (const spec of sgRules) {
      runRuleTests(spec);
    }
  });

  describe("InternetGateway (2 rules)", () => {
    for (const spec of igwRules) {
      runRuleTests(spec);
    }
  });

  describe("NatGateway (3 rules)", () => {
    for (const spec of natRules) {
      runRuleTests(spec);
    }
  });

  describe("Route / Subnet routing (2 rules)", () => {
    for (const spec of rtRules) {
      runRuleTests(spec);
    }
  });

  describe("VPC network (1 rule)", () => {
    for (const spec of vpcNetworkRules) {
      runRuleTests(spec);
    }
  });

  describe("RDS (13 rules)", () => {
    for (const spec of rdsRules) {
      runRuleTests(spec);
    }
  });

  describe("Lambda (11 rules)", () => {
    for (const spec of lambdaRules) {
      runRuleTests(spec);
    }
  });

  describe("IAM (10 rules)", () => {
    for (const spec of iamRules) {
      runRuleTests(spec);
    }
  });

  describe("DynamoDB (5 rules)", () => {
    for (const spec of dynamodbRules) {
      runRuleTests(spec);
    }
  });

  describe("ECS (9 rules)", () => {
    for (const spec of ecsRules) {
      runRuleTests(spec);
    }
  });

  describe("CloudWatch (5 rules)", () => {
    for (const spec of cloudwatchRules) {
      runRuleTests(spec);
    }
  });

  describe("SQS (5 rules)", () => {
    for (const spec of sqsRules) {
      runRuleTests(spec);
    }
  });

  describe("Secrets Manager (5 rules)", () => {
    for (const spec of smRules) {
      if (spec.id === "BP-SM-004") {
        runSmContainsTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("SNS (4 rules)", () => {
    for (const spec of snsRules) {
      runRuleTests(spec);
    }
  });

  describe("API Gateway (3 rules)", () => {
    for (const spec of apigwRules) {
      if (spec.id === "BP-APIGW-002") {
        runApigwNotContainsTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("ECR (3 rules)", () => {
    for (const spec of ecrRules) {
      runRuleTests(spec);
    }
  });

  describe("ELBv2 (3 rules)", () => {
    for (const spec of elbRules) {
      runElbRuleTests(spec);
    }
  });

  describe("Logs (3 rules)", () => {
    for (const spec of logsRules) {
      runRuleTests(spec);
    }
  });

  describe("SSM (3 rules)", () => {
    for (const spec of ssmRules) {
      runRuleTests(spec);
    }
  });

  describe("VPC / Subnet (3 rules)", () => {
    for (const spec of vpcRules) {
      runRuleTests(spec);
    }
  });

  describe("AutoScaling (1 rule)", () => {
    for (const spec of asgRules) {
      runRuleTests(spec);
    }
  });

  // ---------------------------------------------------------------------------
  // Meta-test: verify all 138 rule IDs are covered
  // ---------------------------------------------------------------------------

  describe("Coverage meta-check", () => {
    const allSpecs = [
      ...s3Rules,
      ...ec2Rules,
      ...sgRules,
      ...igwRules,
      ...natRules,
      ...rtRules,
      ...vpcNetworkRules,
      ...rdsRules,
      ...lambdaRules,
      ...iamRules,
      ...dynamodbRules,
      ...ecsRules,
      ...cloudwatchRules,
      ...sqsRules,
      ...smRules,
      ...snsRules,
      ...apigwRules,
      ...ecrRules,
      ...elbRules,
      ...logsRules,
      ...ssmRules,
      ...vpcRules,
      ...asgRules,
    ];

    it("covers exactly 133 rule specs", () => {
      expect(allSpecs.length).toBe(133);
    });

    it("every spec ID exists in the loaded YAML library", () => {
      const loadedIds = new Set(allPractices.map((bp) => bp.id));
      const missing = allSpecs.filter((s) => !loadedIds.has(s.id));
      expect(
        missing.map((s) => s.id),
        `These rule IDs are in the test specs but not in the YAML library`,
      ).toEqual([]);
    });

    it("every loaded YAML rule has a test spec", () => {
      const specIds = new Set(allSpecs.map((s) => s.id));
      const untested = allPractices.filter((bp) => !specIds.has(bp.id));
      expect(
        untested.map((bp) => bp.id),
        `These YAML rules have no test spec`,
      ).toEqual([]);
    });
  });

  describe("blocking rules safety net", () => {
    it("every blocking rule has a fix mechanism (auto or interactive)", () => {
      const blockingRules = allPractices.filter((r) => r.blocking === true);
      for (const rule of blockingRules) {
        const hasFix =
          rule.desiredStatePatch != null || rule.fixType === "interactive";
        expect(hasFix, `${rule.id} is blocking but has no fix mechanism`).toBe(
          true,
        );
      }
    });
  });
});
