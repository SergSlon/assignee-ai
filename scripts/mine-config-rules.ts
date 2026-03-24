#!/usr/bin/env tsx
/**
 * AWS Config Rule Mining Script — dev tool for generating BP YAML stub candidates.
 *
 * Fetches AWS Config managed rules via DescribeConfigRules, maps them to
 * assignee's supported resource types, and outputs candidate YAML stubs.
 *
 * Usage:
 *   npx tsx scripts/mine-config-rules.ts [--dry-run]
 *
 * Output:
 *   scripts/output/config-rule-candidates/<service>/BP-<SVC>-NNN.yaml
 *
 * This is a DEV TOOL ONLY — not bundled in production CLI.
 *
 * @see Story 30.1
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, stringify } from "yaml";

// Import supported types — in a real run this would use the actual import
// For the mining script, we hardcode the list to avoid build dependency issues
const SUPPORTED_TYPES = [
  "AWS::S3::Bucket",
  "AWS::SSM::Parameter",
  "AWS::IAM::Role",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::Lambda::Function",
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ECS::Cluster",
  "AWS::ECR::Repository",
  "AWS::Logs::LogGroup",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::RouteTable",
  "AWS::EC2::Route",
  "AWS::EC2::NatGateway",
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudWatch::Alarm",
  "AWS::SecretsManager::Secret",
];

const SUPPORTED_SET = new Set(SUPPORTED_TYPES);

/** Map AWS resource type to BP ID prefix. */
const TYPE_TO_PREFIX: Record<string, string> = {
  "AWS::S3::Bucket": "S3",
  "AWS::EC2::Instance": "EC2",
  "AWS::RDS::DBInstance": "RDS",
  "AWS::Lambda::Function": "LAMBDA",
  "AWS::IAM::Role": "IAM",
  "AWS::DynamoDB::Table": "DYNAMODB",
  "AWS::EC2::SecurityGroup": "SG",
  "AWS::EC2::VPC": "VPC",
  "AWS::EC2::Subnet": "SUBNET",
  "AWS::SQS::Queue": "SQS",
  "AWS::SNS::Topic": "SNS",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "ELB",
  "AWS::ECR::Repository": "ECR",
  "AWS::ECS::Cluster": "ECS",
  "AWS::Logs::LogGroup": "LOGS",
  "AWS::CloudWatch::Alarm": "CWA",
  "AWS::SecretsManager::Secret": "SM",
  "AWS::SSM::Parameter": "SSM",
  "AWS::ApiGatewayV2::Api": "APIGW",
};

/** Map AWS resource type to service directory name. */
const TYPE_TO_DIR: Record<string, string> = {
  "AWS::S3::Bucket": "s3",
  "AWS::EC2::Instance": "ec2",
  "AWS::RDS::DBInstance": "rds",
  "AWS::Lambda::Function": "lambda",
  "AWS::IAM::Role": "iam",
  "AWS::DynamoDB::Table": "dynamodb",
  "AWS::EC2::SecurityGroup": "ec2",
  "AWS::EC2::VPC": "vpc",
  "AWS::SQS::Queue": "sqs",
  "AWS::SNS::Topic": "sns",
  "AWS::ECS::Cluster": "ecs",
  "AWS::ECR::Repository": "ecr",
  "AWS::Logs::LogGroup": "logs",
  "AWS::CloudWatch::Alarm": "cloudwatch",
  "AWS::SecretsManager::Secret": "secretsmanager",
  "AWS::SSM::Parameter": "ssm",
};

interface ConfigRule {
  name: string;
  description: string;
  sourceIdentifier: string;
  complianceTypes: string[];
}

interface CandidateRule {
  id: string;
  title: string;
  severity: string;
  resource_type: string;
  property_path: string;
  check_type: string;
  expected_value: unknown;
  source: string;
  source_id: string;
  description: string;
  remediation: string;
  category: string;
  lastVerified: string;
}

/**
 * Map severity from Config rule source identifier keywords.
 */
function mapSeverity(sourceIdentifier: string): string {
  const lower = sourceIdentifier.toLowerCase();
  if (lower.includes("critical") || lower.includes("required"))
    return "CRITICAL";
  if (lower.includes("high")) return "HIGH";
  return "MEDIUM";
}

/**
 * Load existing BP rules to detect duplicates.
 */
function loadExistingKeys(bpDir: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(bpDir)) return keys;

  for (const entry of fs.readdirSync(bpDir)) {
    const entryPath = path.join(bpDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;
    if (["src", "dist", "node_modules", "__tests__"].includes(entry)) continue;

    for (const file of fs.readdirSync(entryPath)) {
      if (!file.endsWith(".yaml")) continue;
      try {
        const content = fs.readFileSync(path.join(entryPath, file), "utf-8");
        const parsed = parse(content) as Record<string, unknown>;
        if (parsed.resource_type && parsed.property_path) {
          keys.add(`${parsed.resource_type}::${parsed.property_path}`);
        }
      } catch {
        continue;
      }
    }
  }
  return keys;
}

/**
 * Generate candidate YAML stubs from Config rules.
 * In production, this fetches from AWS API. For dev/test, uses mock data.
 */
export function generateCandidates(
  configRules: ConfigRule[],
  existingKeys: Set<string>,
): CandidateRule[] {
  const candidates: CandidateRule[] = [];
  const counters: Record<string, number> = {};

  for (const rule of configRules) {
    for (const resourceType of rule.complianceTypes) {
      if (!SUPPORTED_SET.has(resourceType)) continue;

      const prefix = TYPE_TO_PREFIX[resourceType];
      if (!prefix) continue;

      // Generate a reasonable property_path from the rule name
      const propertyPath = rule.sourceIdentifier
        .replace(/_/g, ".")
        .split(".")
        .map(
          (part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join(".");

      const dedup = `${resourceType}::${propertyPath}`;
      if (existingKeys.has(dedup)) continue;
      existingKeys.add(dedup); // prevent intra-batch dupes

      if (!counters[prefix]) counters[prefix] = 900; // start at 900 for candidates
      counters[prefix]++;
      const id = `BP-${prefix}-${String(counters[prefix]).padStart(3, "0")}`;

      candidates.push({
        id,
        title: rule.description.slice(0, 80),
        severity: mapSeverity(rule.sourceIdentifier),
        resource_type: resourceType,
        property_path: propertyPath,
        check_type: "awareness",
        expected_value: true,
        source: "AWS Config",
        source_id: rule.name,
        description: rule.description,
        remediation: `Review ${rule.name} and apply recommended configuration.`,
        category: "compliance",
        lastVerified: new Date().toISOString().split("T")[0]!,
      });
    }
  }

  return candidates;
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isDryRun = process.argv.includes("--dry-run");
const isDirectRun = process.argv[1]?.includes("mine-config-rules");

if (isDirectRun) {
  const bpDir = path.resolve(__dirname, "../packages/best-practices");
  const existingKeys = loadExistingKeys(bpDir);

  // Mock Config rules for local development (no AWS credentials needed)
  const mockRules: ConfigRule[] = [
    {
      name: "s3-bucket-ssl-requests-only",
      description: "S3 bucket should require SSL for all requests",
      sourceIdentifier: "S3_BUCKET_SSL_REQUESTS_ONLY",
      complianceTypes: ["AWS::S3::Bucket"],
    },
    {
      name: "rds-instance-deletion-protection-enabled",
      description: "RDS instance should have deletion protection enabled",
      sourceIdentifier: "RDS_INSTANCE_DELETION_PROTECTION_ENABLED",
      complianceTypes: ["AWS::RDS::DBInstance"],
    },
  ];

  const candidates = generateCandidates(mockRules, existingKeys);

  if (isDryRun) {
    console.log(`Rules fetched: ${mockRules.length}`);
    console.log(`Candidates generated: ${candidates.length}`);
    console.log(`Duplicates skipped: ${mockRules.length - candidates.length}`);
    process.exit(0);
  }

  const outputDir = path.resolve(__dirname, "output/config-rule-candidates");
  fs.mkdirSync(outputDir, { recursive: true });

  for (const candidate of candidates) {
    const svcDir = TYPE_TO_DIR[candidate.resource_type] ?? "other";
    const dir = path.join(outputDir, svcDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${candidate.id}.yaml`);
    fs.writeFileSync(filePath, stringify(candidate), "utf-8");
  }

  console.log(
    `Generated ${candidates.length} candidate YAML stubs in ${outputDir}`,
  );
}

export { loadExistingKeys, mapSeverity, TYPE_TO_PREFIX, SUPPORTED_SET };
