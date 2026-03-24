#!/usr/bin/env node
/**
 * Builds the final mcp-mock-responses.ts from processed captures.
 * Reads processed-responses/*.json and outputs the TypeScript fixture file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROC_DIR = resolve(__dirname, "processed-responses");
const OUT_FILE = resolve(__dirname, "../src/test-fixtures/mcp-mock-responses.ts");

function readProcessed(filename) {
  return JSON.parse(readFileSync(resolve(PROC_DIR, filename), "utf-8"));
}

function essentialSchemaProps(schema, maxProps) {
  const parsed = JSON.parse(schema.text);
  const allProps = Object.keys(parsed.properties || {});
  if (allProps.length <= maxProps) return schema;

  const PRIORITY_FIELDS = [
    "Tags", "Arn",
    "BucketName", "VersioningConfiguration", "BucketEncryption", "AccessControl",
    "PublicAccessBlockConfiguration", "LifecycleConfiguration",
    "InstanceType", "ImageId", "KeyName", "SecurityGroupIds", "SubnetId",
    "InstanceId", "BlockDeviceMappings",
    "FunctionName", "Runtime", "Role", "Handler", "Code", "MemorySize", "Timeout",
    "Environment", "FunctionArn", "Architectures",
    "DBInstanceIdentifier", "DBInstanceClass", "Engine", "MasterUsername",
    "MasterUserPassword", "AllocatedStorage", "StorageType", "MultiAZ",
    "EngineVersion", "DBName", "Port",
    "RoleName", "AssumeRolePolicyDocument", "ManagedPolicyArns", "Policies",
    "Path", "MaxSessionDuration",
    "TableName", "KeySchema", "AttributeDefinitions", "BillingMode",
    "ProvisionedThroughput", "GlobalSecondaryIndexes",
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

function trimPricingData(pricing, maxItems) {
  const parsed = JSON.parse(pricing.text);
  if (parsed.data && parsed.data.length > maxItems) {
    parsed.data = parsed.data.slice(0, maxItems);
  }
  return { type: "text", text: JSON.stringify(parsed) };
}

/** Indent JSON for TypeScript embedding */
function indent(json, level = 2) {
  const spaces = "  ".repeat(level);
  return json.split("\n").join("\n" + spaces);
}

/** Format MCP text response as TypeScript object literal */
function fmtMcpText(data) {
  // Parse the text to get pretty JSON
  try {
    const inner = JSON.parse(data.text);
    const pretty = JSON.stringify(inner, null, 2);
    return `mcpText(${indent(pretty, 3)})`;
  } catch {
    // Not JSON — it's markdown or an error string. Use template literal.
    const escaped = data.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
    return `{ type: "text" as const, text: \`${escaped}\` }`;
  }
}

/** Format structured content (doc search) as TypeScript */
function fmtStructured(data) {
  return JSON.stringify(data, null, 2);
}

// ── Load and process all data ───────────────────────────────────────────────

const schemaConfigs = [
  { key: "s3Bucket", file: "schema-s3Bucket.json", maxProps: 10, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::S3::Bucket\" }. 30 props in full schema, trimmed to 10." },
  { key: "ec2Instance", file: "schema-ec2Instance.json", maxProps: 10, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::EC2::Instance\" }. 48 props in full schema, trimmed to 10." },
  { key: "lambdaFunction", file: "schema-lambdaFunction.json", maxProps: 10, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::Lambda::Function\" }. 33 props in full schema, trimmed to 10." },
  { key: "rdsDbInstance", file: "schema-rdsDbInstance.json", maxProps: 12, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::RDS::DBInstance\" }. 99 props in full schema, trimmed to 12." },
  { key: "iamRole", file: "schema-iamRole.json", maxProps: 11, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::IAM::Role\" }. 11 props (all kept)." },
  { key: "dynamoDbTable", file: "schema-dynamoDbTable.json", maxProps: 10, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::DynamoDB::Table\" }. 22 props in full schema, trimmed to 10." },
  { key: "ssmParameter", file: "schema-ssmParameter.json", maxProps: 9, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::SSM::Parameter\" }. 9 props (all kept)." },
  { key: "generic", file: "schema-generic.json", maxProps: 0, comment: "Captured 2026-03-22 via DescribeType. Input: { resource_type: \"AWS::Custom::FakeResource\" }. Returns error (TypeNotFoundException)." },
];

const pricingConfigs = [
  { key: "s3Storage", file: "pricing-s3Storage.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonS3\", filters: [productFamily=Storage, usagetype=TimedStorage-ByteHrs] }" },
  { key: "ec2T3Micro", file: "pricing-ec2T3Micro.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonEC2\", filters: [instanceType=t3.micro, os=Linux, tenancy=Shared] }" },
  { key: "ec2T3Small", file: "pricing-ec2T3Small.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonEC2\", filters: [instanceType=t3.small, os=Linux, tenancy=Shared] }" },
  { key: "ec2M5Large", file: "pricing-ec2M5Large.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonEC2\", filters: [instanceType=m5.large, os=Linux, tenancy=Shared] }" },
  { key: "rdsT3MicroPostgres", file: "pricing-rdsT3MicroPostgres.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonRDS\", filters: [instanceType=db.t3.micro, engine=PostgreSQL, deployment=Single-AZ] }" },
  { key: "rdsT3MicroMysql", file: "pricing-rdsT3MicroMysql.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonRDS\", filters: [instanceType=db.t3.micro, engine=MySQL, deployment=Single-AZ] }" },
  { key: "rdsR6gLargeAuroraPostgres", file: "pricing-rdsR6gLargeAuroraPostgres.json", trim: 1, comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonRDS\", filters: [instanceType=db.r6g.large, engine=Aurora PostgreSQL] }. 2 items captured, 1 kept." },
  { key: "rdsR6gLargeAuroraMysql", file: "pricing-rdsR6gLargeAuroraMysql.json", trim: 1, comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonRDS\", filters: [instanceType=db.r6g.large, engine=Aurora MySQL] }. 2 items captured, 1 kept." },
  { key: "rdsT3MicroMariadb", file: "pricing-rdsT3MicroMariadb.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonRDS\", filters: [instanceType=db.t3.micro, engine=MariaDB, deployment=Single-AZ] }" },
  { key: "ssmParameter", file: "pricing-ssmParameter.json", trim: 1, comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AWSSystemsManager\", filters: [productFamily=AWS Systems Manager] }. 34 items captured, 1 kept." },
  { key: "emptyData", file: "pricing-emptyData.json", comment: "Captured 2026-03-22 from aws-pricing-mcp-server. Input: { service_code: \"AmazonEC2\", filters: [instanceType=z99.nonexistent] }. Server returns error with suggestion." },
];

const docSearchConfigs = [
  { key: "s3BucketName", file: "docSearch-s3BucketName.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: \"BucketName AWS::S3::Bucket\" }. 10 results, 3 kept." },
  { key: "ec2InstanceType", file: "docSearch-ec2InstanceType.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: \"InstanceType AWS::EC2::Instance\" }" },
  { key: "lambdaRuntime", file: "docSearch-lambdaRuntime.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: \"Runtime AWS::Lambda::Function\" }" },
  { key: "rdsEngine", file: "docSearch-rdsEngine.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server. Input: { search_phrase: \"Engine AWS::RDS::DBInstance\" }" },
];

const docReadSectionsConfigs = [
  { key: "s3BucketName", file: "docRead-readSections-s3BucketName.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server read_sections. Input: { url: CFN S3 Bucket page, section_titles: [Overview,Description,Properties,Syntax] }. Truncated from 24K chars." },
  { key: "ec2InstanceType", file: "docRead-readSections-ec2InstanceType.json", comment: "Captured 2026-03-22. read_sections on CFN EC2 Instance page. Truncated from 50K chars." },
  { key: "lambdaRuntime", file: "docRead-readSections-lambdaRuntime.json", comment: "Captured 2026-03-22. read_sections on CFN Lambda Function page. Truncated from 28K chars." },
  { key: "rdsEngine", file: "docRead-readSections-rdsEngine.json", comment: "Captured 2026-03-22. read_sections on CFN RDS DBInstance page. Truncated from 97K chars." },
  { key: "dynamoDbBillingMode", file: "docRead-readSections-dynamoDbBillingMode.json", comment: "Captured 2026-03-22. read_sections on CFN DynamoDB Table page. Truncated from 20K chars." },
];

const docReadFullConfigs = [
  { key: "s3BucketFull", file: "docRead-readFull-s3Bucket.json", comment: "Captured 2026-03-22 from aws-documentation-mcp-server read_documentation. Full S3 Bucket page, truncated from 5K chars." },
  { key: "lambdaFunctionFull", file: "docRead-readFull-lambdaFunction.json", comment: "Captured 2026-03-22. Full Lambda Function page, truncated from 5K chars." },
];

// ── Generate the file ───────────────────────────────────────────────────────

let ts = `/**
 * Comprehensive MCP mock responses for all 4 servers and 5 tools.
 * ALL response data captured from live MCP servers on 2026-03-22.
 *
 * Usage in tests:
 *   import { McpMocks, createMockTool } from "../test-fixtures/mcp-mock-responses.js";
 *   const tool = createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success);
 *
 * All responses mirror the real MCP wire format: { type: "text", text: "<json>" }
 * See: apps/cli/src/utils/mcp.ts — unwrapMcpText()
 *
 * aws-knowledge-mcp-server: configured but no app code calls its tools — no mocks needed.
 */

import { vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";

// ── Helper: wrap JSON in MCP content block ──────────────────────────────────

function mcpText(payload: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(payload) };
}

`;

// ── Schemas ─────────────────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// 1. CloudFormation Resource Schemas
//    Originally captured 2026-03-22 via DescribeType SDK
// ═══════════════════════════════════════════════════════════════════════════════

const schemaResponses = {\n`;

for (const cfg of schemaConfigs) {
  let data = readProcessed(cfg.file);
  if (data.type === "text" && !data.text.startsWith("Error") && cfg.maxProps > 0) {
    data = essentialSchemaProps(data, cfg.maxProps);
  }
  ts += `  /** ${cfg.comment} */\n`;
  ts += `  ${cfg.key}: {\n`;
  ts += `    success: ${fmtMcpText(data)},\n`;
  ts += `  },\n\n`;
}

// Add empty schema (synthetic)
ts += `  /** Synthetic: empty schema edge case — DescribeType never returns empty schemas for known types. */\n`;
ts += `  empty: {\n`;
ts += `    success: mcpText({\n`;
ts += `      typeName: "AWS::Unknown::Type",\n`;
ts += `      properties: {},\n`;
ts += `    }),\n`;
ts += `  },\n`;

ts += `} as const;\n\n`;

// ── Pricing ─────────────────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// 2. aws-pricing-mcp-server — get_pricing
//    Captured 2026-03-22 via: uvx --with "botocore[crt]" awslabs.aws-pricing-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const pricingResponses = {\n`;

for (const cfg of pricingConfigs) {
  let data = readProcessed(cfg.file);
  if (cfg.trim) data = trimPricingData(data, cfg.trim);
  ts += `  /** ${cfg.comment} */\n`;
  ts += `  ${cfg.key}: {\n`;
  ts += `    success: ${fmtMcpText(data)},\n`;
  ts += `  },\n\n`;
}

// Add synthetic edge cases
ts += `  /** Synthetic: zero-price response — constructed for free-tier edge case testing. */\n`;
ts += `  zeroPrice: {\n`;
ts += `    success: mcpText({\n`;
ts += `      data: [{\n`;
ts += `        terms: {\n`;
ts += `          OnDemand: {\n`;
ts += `            "TERM-FREE": {\n`;
ts += `              priceDimensions: {\n`;
ts += `                "DIM-FREE": {\n`;
ts += `                  beginRange: "0",\n`;
ts += `                  pricePerUnit: { USD: "0.0000000000" },\n`;
ts += `                },\n`;
ts += `              },\n`;
ts += `            },\n`;
ts += `          },\n`;
ts += `        },\n`;
ts += `      }],\n`;
ts += `    }),\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: empty response object — MCP server returned valid JSON but no data key. */\n`;
ts += `  emptyResponse: {\n`;
ts += `    success: mcpText({}),\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: malformed response — text field is not valid JSON. */\n`;
ts += `  malformedJson: {\n`;
ts += `    success: { type: "text" as const, text: "not valid json {{{" },\n`;
ts += `  },\n`;

ts += `} as const;\n\n`;

// ── Doc Search ──────────────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// 3. aws-documentation-mcp-server — search_documentation
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docSearchResponses = {\n`;

for (const cfg of docSearchConfigs) {
  const data = readProcessed(cfg.file);
  ts += `  /** ${cfg.comment} */\n`;
  ts += `  ${cfg.key}: {\n`;
  ts += `    success: ${indent(fmtStructured(data), 2)},\n`;
  ts += `  },\n\n`;
}

// Add synthetic edge cases
ts += `  /** Synthetic: unstructured response — URL embedded in plain text (regex fallback path). */\n`;
ts += `  unstructuredWithUrl: {\n`;
ts += `    success: "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: empty search results — no URLs in structured response. */\n`;
ts += `  emptyResults: {\n`;
ts += `    success: {\n`;
ts += `      structuredContent: {\n`;
ts += `        search_results: [],\n`;
ts += `      },\n`;
ts += `    },\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: no results — plain text response with no URL. */\n`;
ts += `  noResultsText: {\n`;
ts += `    success: "No results found for the given search phrase.",\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: null response — server returned nothing. */\n`;
ts += `  nullResponse: {\n`;
ts += `    success: null,\n`;
ts += `  },\n`;

ts += `} as const;\n\n`;

// ── Doc Read Sections ───────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// 4. aws-documentation-mcp-server — read_sections
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docReadSectionsResponses = {\n`;

for (const cfg of docReadSectionsConfigs) {
  const data = readProcessed(cfg.file);
  ts += `  /** ${cfg.comment} */\n`;
  ts += `  ${cfg.key}: {\n`;
  ts += `    success: ${fmtMcpText(data)},\n`;
  ts += `  },\n\n`;
}

// Add synthetic edge cases
ts += `  /** Synthetic: very long content — stress test for truncation/synthesis. */\n`;
ts += `  longContent: {\n`;
ts += `    success: mcpText(\n`;
ts += `      "## Overview\\n\\n" +\n`;
ts += `      "This is a very long documentation page that covers many aspects of the resource configuration. ".repeat(50) +\n`;
ts += `      "\\n\\n## Properties\\n\\n" +\n`;
ts += `      "PropertyA: Description of property A.\\n" +\n`;
ts += `      "PropertyB: Description of property B.\\n" +\n`;
ts += `      "PropertyC: Description of property C.\\n",\n`;
ts += `    ),\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: response with "Note: not found" pattern — stripped by display.ts regex. */\n`;
ts += `  withNotFoundNote: {\n`;
ts += `    success: mcpText(\n`;
ts += `      "> **Note**: Section 'Syntax' not found in the document.\\n\\n" +\n`;
ts += `      "## Properties\\n\\n" +\n`;
ts += `      "**BucketName**\\n" +\n`;
ts += `      "A name for the bucket.",\n`;
ts += `    ),\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: no matching sections error — triggers fallback to read_documentation. */\n`;
ts += `  noMatchingSections: {\n`;
ts += `    error: new Error("No matching sections were found"),\n`;
ts += `  },\n\n`;

ts += `  /** Synthetic: generic server error. */\n`;
ts += `  serverError: {\n`;
ts += `    error: new Error("Internal server error: documentation service unavailable"),\n`;
ts += `  },\n`;

ts += `} as const;\n\n`;

// ── Doc Read Full ───────────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// 5. aws-documentation-mcp-server — read_documentation (full page fallback)
//    Captured 2026-03-22 via: uvx awslabs.aws-documentation-mcp-server@latest
// ═══════════════════════════════════════════════════════════════════════════════

const docReadFullResponses = {\n`;

for (const cfg of docReadFullConfigs) {
  const data = readProcessed(cfg.file);
  ts += `  /** ${cfg.comment} */\n`;
  ts += `  ${cfg.key}: {\n`;
  ts += `    success: ${fmtMcpText(data)},\n`;
  ts += `  },\n\n`;
}

ts += `  /** Synthetic: empty page — edge case. */\n`;
ts += `  emptyPage: {\n`;
ts += `    success: mcpText(""),\n`;
ts += `  },\n`;

ts += `} as const;\n\n`;

// ── Exported namespace ──────────────────────────────────────────────────────

ts += `// ═══════════════════════════════════════════════════════════════════════════════
// Exported namespace
// ═══════════════════════════════════════════════════════════════════════════════

export const McpMocks = {
  schema: schemaResponses,
  pricing: pricingResponses,
  docSearch: docSearchResponses,
  docReadSections: docReadSectionsResponses,
  docReadFull: docReadFullResponses,
} as const;

`;

// ── Factory functions (unchanged from original) ─────────────────────────────

ts += readFileSync(resolve(__dirname, "_factory-functions.ts.template"), "utf-8");

writeFileSync(OUT_FILE, ts);
console.log(`Generated: ${OUT_FILE}`);
console.log(`Size: ${(ts.length / 1024).toFixed(1)} KB`);
