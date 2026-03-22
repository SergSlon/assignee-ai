#!/usr/bin/env node
/**
 * Generates the final mcp-mock-responses.ts fixture file from processed captures.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROC_DIR = resolve(__dirname, "processed-responses");
const OUT_DIR = PROC_DIR;
const OUT_FILE = resolve(__dirname, "../src/test-fixtures/mcp-mock-responses.ts");

function readProcessed(filename) {
  return JSON.parse(readFileSync(resolve(PROC_DIR, filename), "utf-8"));
}

// ── Schema: further trim large schemas to essential properties ───────────────

function essentialSchemaProps(schema, maxProps = 15) {
  const parsed = JSON.parse(schema.text);
  const allProps = Object.keys(parsed.properties || {});
  if (allProps.length <= maxProps) return schema;

  // Keep only the most important properties for testing
  const PRIORITY_FIELDS = [
    // Common across resources
    "Tags", "Arn",
    // S3
    "BucketName", "VersioningConfiguration", "BucketEncryption", "AccessControl",
    "PublicAccessBlockConfiguration", "LifecycleConfiguration", "LoggingConfiguration",
    // EC2
    "InstanceType", "ImageId", "KeyName", "SecurityGroupIds", "SubnetId",
    "InstanceId", "BlockDeviceMappings", "Monitoring", "UserData",
    // Lambda
    "FunctionName", "Runtime", "Role", "Handler", "Code", "MemorySize", "Timeout",
    "Environment", "FunctionArn", "Architectures", "EphemeralStorage",
    // RDS
    "DBInstanceIdentifier", "DBInstanceClass", "Engine", "MasterUsername",
    "MasterUserPassword", "AllocatedStorage", "StorageType", "MultiAZ",
    "EngineVersion", "DBName", "Port", "VPCSecurityGroups", "BackupRetentionPeriod",
    "DbiResourceId", "Endpoint",
    // IAM
    "RoleName", "AssumeRolePolicyDocument", "ManagedPolicyArns", "Policies",
    "Path", "MaxSessionDuration", "PermissionsBoundary",
    // DynamoDB
    "TableName", "KeySchema", "AttributeDefinitions", "BillingMode",
    "ProvisionedThroughput", "GlobalSecondaryIndexes", "StreamSpecification",
    "TableId", "Arn",
    // SSM
    "Name", "Type", "Value", "Description", "AllowedPattern", "DataType",
  ];

  const kept = {};
  let count = 0;
  for (const field of PRIORITY_FIELDS) {
    if (field in parsed.properties && count < maxProps) {
      kept[field] = parsed.properties[field];
      count++;
    }
  }

  parsed.properties = kept;
  return { type: "text", text: JSON.stringify(parsed) };
}

// ── Pricing: trim SSM to 1 item ─────────────────────────────────────────────

function trimPricingData(pricing, maxItems = 1) {
  const parsed = JSON.parse(pricing.text);
  if (parsed.data && parsed.data.length > maxItems) {
    parsed.data = parsed.data.slice(0, maxItems);
  }
  return { type: "text", text: JSON.stringify(parsed) };
}

// ── Aurora pricing: keep only 1 item ────────────────────────────────────────

function trimAuroraPricing(pricing) {
  return trimPricingData(pricing, 1);
}

// ── Format a JS object as compact but readable code ─────────────────────────

function formatMcpTextLiteral(data) {
  // data is { type: "text", text: "<json string>" }
  // We want to output the raw JSON string as a template literal for readability
  const inner = data.text;
  // Escape backticks and ${} in the string
  const escaped = inner.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `{ type: "text" as const, text: \`${escaped}\` }`;
}

function formatStructuredContent(data) {
  return JSON.stringify(data, null, 6).replace(/\n/g, "\n    ");
}

// ── Build the fixture file ──────────────────────────────────────────────────

function buildSchemaSection() {
  const entries = [];

  const schemas = [
    { key: "s3Bucket", file: "schema-s3Bucket.json", desc: "S3 Bucket — 30 props in full schema", maxProps: 12 },
    { key: "ec2Instance", file: "schema-ec2Instance.json", desc: "EC2 Instance — 48 props in full schema", maxProps: 12 },
    { key: "lambdaFunction", file: "schema-lambdaFunction.json", desc: "Lambda Function — 33 props in full schema", maxProps: 12 },
    { key: "rdsDbInstance", file: "schema-rdsDbInstance.json", desc: "RDS DBInstance — 99 props in full schema", maxProps: 15 },
    { key: "iamRole", file: "schema-iamRole.json", desc: "IAM Role — 11 props in full schema", maxProps: 15 },
    { key: "dynamoDbTable", file: "schema-dynamoDbTable.json", desc: "DynamoDB Table — 22 props in full schema", maxProps: 12 },
    { key: "ssmParameter", file: "schema-ssmParameter.json", desc: "SSM Parameter — 9 props in full schema", maxProps: 15 },
    { key: "generic", file: "schema-generic.json", desc: "Nonexistent type → error response", maxProps: 0 },
  ];

  for (const s of schemas) {
    const raw = readProcessed(s.file);
    let processed;
    if (raw.type === "text" && !raw.text.startsWith("Error")) {
      processed = essentialSchemaProps(raw, s.maxProps);
    } else {
      processed = raw;
    }
    entries.push({ key: s.key, data: processed, desc: s.desc });
  }

  return entries;
}

function buildPricingSection() {
  const entries = [];

  const pricings = [
    { key: "s3Storage", file: "pricing-s3Storage.json", desc: "S3 storage multi-tier" },
    { key: "ec2T3Micro", file: "pricing-ec2T3Micro.json", desc: "EC2 t3.micro on-demand" },
    { key: "ec2T3Small", file: "pricing-ec2T3Small.json", desc: "EC2 t3.small on-demand" },
    { key: "ec2M5Large", file: "pricing-ec2M5Large.json", desc: "EC2 m5.large on-demand" },
    { key: "rdsT3MicroPostgres", file: "pricing-rdsT3MicroPostgres.json", desc: "RDS db.t3.micro PostgreSQL Single-AZ" },
    { key: "rdsT3MicroMysql", file: "pricing-rdsT3MicroMysql.json", desc: "RDS db.t3.micro MySQL Single-AZ" },
    { key: "rdsR6gLargeAuroraPostgres", file: "pricing-rdsR6gLargeAuroraPostgres.json", desc: "RDS db.r6g.large Aurora PostgreSQL", trim: true },
    { key: "rdsR6gLargeAuroraMysql", file: "pricing-rdsR6gLargeAuroraMysql.json", desc: "RDS db.r6g.large Aurora MySQL", trim: true },
    { key: "rdsT3MicroMariadb", file: "pricing-rdsT3MicroMariadb.json", desc: "RDS db.t3.micro MariaDB Single-AZ" },
    { key: "ssmParameter", file: "pricing-ssmParameter.json", desc: "SSM Parameter Store (34 items → 1 kept)", trimSsm: true },
    { key: "emptyData", file: "pricing-emptyData.json", desc: "No matching products (z99.nonexistent)" },
  ];

  for (const p of pricings) {
    let raw = readProcessed(p.file);
    if (p.trim) raw = trimAuroraPricing(raw);
    if (p.trimSsm) raw = trimPricingData(raw, 1);
    entries.push({ key: p.key, data: raw, desc: p.desc });
  }

  return entries;
}

function buildDocSearchSection() {
  const entries = [];

  const searches = [
    { key: "s3BucketName", file: "docSearch-s3BucketName.json", desc: "S3 BucketName search — 10 results, 3 kept" },
    { key: "ec2InstanceType", file: "docSearch-ec2InstanceType.json", desc: "EC2 InstanceType search" },
    { key: "lambdaRuntime", file: "docSearch-lambdaRuntime.json", desc: "Lambda Runtime search" },
    { key: "rdsEngine", file: "docSearch-rdsEngine.json", desc: "RDS Engine search" },
  ];

  for (const s of searches) {
    const raw = readProcessed(s.file);
    entries.push({ key: s.key, data: raw, desc: s.desc });
  }

  return entries;
}

function buildDocReadSectionsSection() {
  const entries = [];

  const reads = [
    { key: "s3BucketName", file: "docRead-readSections-s3BucketName.json", desc: "S3 BucketName sections" },
    { key: "ec2InstanceType", file: "docRead-readSections-ec2InstanceType.json", desc: "EC2 InstanceType sections" },
    { key: "lambdaRuntime", file: "docRead-readSections-lambdaRuntime.json", desc: "Lambda Runtime sections" },
    { key: "rdsEngine", file: "docRead-readSections-rdsEngine.json", desc: "RDS Engine sections" },
    { key: "dynamoDbBillingMode", file: "docRead-readSections-dynamoDbBillingMode.json", desc: "DynamoDB BillingMode sections" },
  ];

  for (const r of reads) {
    const raw = readProcessed(r.file);
    entries.push({ key: r.key, data: raw, desc: r.desc });
  }

  return entries;
}

function buildDocReadFullSection() {
  const entries = [];

  const reads = [
    { key: "s3BucketFull", file: "docRead-readFull-s3Bucket.json", desc: "Full S3 Bucket page" },
    { key: "lambdaFunctionFull", file: "docRead-readFull-lambdaFunction.json", desc: "Full Lambda Function page" },
  ];

  for (const r of reads) {
    const raw = readProcessed(r.file);
    entries.push({ key: r.key, data: raw, desc: r.desc });
  }

  return entries;
}

// ── Generate TypeScript ─────────────────────────────────────────────────────

const schemas = buildSchemaSection();
const pricings = buildPricingSection();
const docSearches = buildDocSearchSection();
const docReadSections = buildDocReadSectionsSection();
const docReadFulls = buildDocReadFullSection();

// Write a JSON manifest that we'll use to generate the TS file
const manifest = {
  schemas,
  pricings,
  docSearches,
  docReadSections,
  docReadFulls,
};

writeFileSync(resolve(OUT_DIR, "_manifest.json"), JSON.stringify(manifest, null, 2));
console.log("Manifest written to processed-responses/_manifest.json");

// Now check sizes
let totalSize = 0;
for (const s of schemas) totalSize += JSON.stringify(s.data).length;
for (const p of pricings) totalSize += JSON.stringify(p.data).length;
for (const d of docSearches) totalSize += JSON.stringify(d.data).length;
for (const d of docReadSections) totalSize += JSON.stringify(d.data).length;
for (const d of docReadFulls) totalSize += JSON.stringify(d.data).length;

console.log(`\nTotal data size: ${(totalSize / 1024).toFixed(1)} KB`);
console.log("  Schemas:", schemas.map(s => `${s.key}(${(JSON.stringify(s.data).length/1024).toFixed(1)}K)`).join(", "));
console.log("  Pricing:", pricings.map(p => `${p.key}(${(JSON.stringify(p.data).length/1024).toFixed(1)}K)`).join(", "));
