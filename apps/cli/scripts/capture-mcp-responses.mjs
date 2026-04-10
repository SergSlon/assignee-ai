#!/usr/bin/env node
/**
 * MCP Response Capture Script — HISTORICAL / DEV-ONLY
 *
 * STATUS: Retained for historical regeneration of test fixtures.
 *   The `awslabs.cfn-mcp-server` capture path is no longer reachable
 *   in production: CloudFormation schemas are now fetched via
 *   `@aws-sdk/client-cloudformation` DescribeType (Story 31.1).
 *   The cached CFN schema fixtures remain valid because they shape-match
 *   what the SDK returns. Do NOT spawn cfn-mcp-server in any runtime path —
 *   `apps/cli/src/config/mcp-servers.test.ts` enforces this with a guardrail.
 *
 * Spawns each MCP server via uvx and calls tools with representative inputs.
 * Saves raw wire-format JSON responses to captured-responses/ directory.
 *
 * Usage: node apps/cli/scripts/capture-mcp-responses.mjs
 * Requires: .env with ASSIGNEE_READER_ACCESS_KEY_ID and ASSIGNEE_READER_SECRET_ACCESS_KEY
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "captured-responses");
mkdirSync(OUT_DIR, { recursive: true });

// Load .env manually
const envPath = resolve(__dirname, "../../../.env");
const envLines = readFileSync(envPath, "utf-8").split("\n");
for (const line of envLines) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const val = match[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

const MCP_ENV = {
  AWS_ACCESS_KEY_ID: process.env.ASSIGNEE_READER_ACCESS_KEY_ID ?? "",
  AWS_SECRET_ACCESS_KEY: process.env.ASSIGNEE_READER_SECRET_ACCESS_KEY ?? "",
  AWS_DEFAULT_REGION: "us-east-1",
  FASTMCP_LOG_LEVEL: "ERROR",
};

// ── Pinned MCP server versions ──────────────────────────────────────────────
// V3 audit finding (2026-04-06): never use @latest in fixture-capture scripts.
// Unpinned upstream creates a fixture-supply-chain risk — a compromised package
// would silently land in our captured-responses/ corpus on the next refresh.
//
// MUST be kept in sync with apps/cli/src/config/mcp-servers.ts MCP_PINS.
// CI guard: apps/cli/src/services/mcp-client.unit.test.ts asserts MCP_PINS
// never contains @latest. When bumping a pin in mcp-servers.ts, also bump
// the matching value here.
const MCP_PINS = {
  AWS_PRICING: "awslabs.aws-pricing-mcp-server@1.0.27",
  AWS_DOCUMENTATION: "awslabs.aws-documentation-mcp-server@1.1.20",
  AWS_IAM: "awslabs.iam-mcp-server@1.0.17",
  AWS_WA_SECURITY: "awslabs.well-architected-security-mcp-server@0.1.7",
  AWS_COST_MANAGEMENT: "awslabs.billing-cost-management-mcp-server@0.0.17",
  // CFN server isn't part of the runtime CLI MCP_PINS (it's only used to
  // refresh fixtures here) but we still pin it for the same supply-chain
  // reason. Bump deliberately after reviewing upstream release notes.
  // Pinned 2026-04-06 to whatever was the latest stable at the time.
  AWS_CFN: "awslabs.cfn-mcp-server@1.0.19",
};

// ─── JSON-RPC over stdio (newline-delimited) ───────────────────────────────

let nextId = 1;

function sendJsonRpc(proc, method, params) {
  const id = nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  proc.stdin.write(msg + "\n");
  return id;
}

function sendNotification(proc, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  proc.stdin.write(msg + "\n");
}

function readResponses(proc, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const responses = new Map();
    const timer = setTimeout(() => {
      proc.stdout.removeAllListeners("data");
      resolve(responses);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // Parse newline-delimited JSON messages
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id !== undefined) {
            responses.set(parsed.id, parsed);
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on("data", (chunk) => {
      // Log server errors to help debug
      const msg = chunk.toString().trim();
      if (msg && !msg.includes("DEBUG") && !msg.includes("INFO")) {
        process.stderr.write(`  [stderr] ${msg}\n`);
      }
    });

    proc.on("close", () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });
}

async function callMcpServer(name, command, args, env, toolCalls) {
  console.log(`\n═══ ${name} ═══`);
  console.log(`  Spawning: ${command} ${args.join(" ")}`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const responsePromise = readResponses(proc, 45000);

  // Wait a bit for server startup
  await sleep(2000);

  // Initialize
  const initId = sendJsonRpc(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "capture-script", version: "1.0.0" },
  });
  console.log(`  Sent initialize (id=${initId})`);
  await sleep(1000);

  // Send initialized notification
  sendNotification(proc, "notifications/initialized");
  await sleep(500);

  // Call each tool
  const idToCall = new Map();
  for (const call of toolCalls) {
    const id = sendJsonRpc(proc, "tools/call", {
      name: call.tool,
      arguments: call.args,
    });
    idToCall.set(id, call);
    console.log(`  Sent tools/call: ${call.tool} (id=${id}, key=${call.key})`);
    // Small delay between calls to avoid overwhelming the server
    await sleep(500);
  }

  // Wait for all responses
  await sleep(3000);

  // Close stdin to signal we're done
  proc.stdin.end();

  const responses = await responsePromise;

  // Save responses
  const results = {};
  for (const [id, call] of idToCall) {
    const resp = responses.get(id);
    if (resp) {
      const filename = `${name}--${call.key}.json`;
      writeFileSync(resolve(OUT_DIR, filename), JSON.stringify(resp.result, null, 2));
      results[call.key] = resp.result;
      console.log(`  ✓ ${call.key} → ${filename}`);
    } else {
      console.log(`  ✗ ${call.key} — no response received`);
    }
  }

  // Kill the server
  proc.kill("SIGTERM");
  return results;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Capture definitions ────────────────────────────────────────────────────

async function captureCfnSchemas() {
  const resourceTypes = [
    { key: "s3Bucket", type: "AWS::S3::Bucket" },
    { key: "ec2Instance", type: "AWS::EC2::Instance" },
    { key: "lambdaFunction", type: "AWS::Lambda::Function" },
    { key: "rdsDbInstance", type: "AWS::RDS::DBInstance" },
    { key: "iamRole", type: "AWS::IAM::Role" },
    { key: "dynamoDbTable", type: "AWS::DynamoDB::Table" },
    { key: "ssmParameter", type: "AWS::SSM::Parameter" },
    { key: "generic", type: "AWS::Custom::FakeResource" },
  ];

  // NOTE: Schema fetching in the app now uses CloudFormationSchemaService (DescribeType SDK).
  // This capture path is retained for regenerating legacy test fixture data.
  return await callMcpServer(
    "cfn-mcp-server",
    "uvx",
    [MCP_PINS.AWS_CFN],
    MCP_ENV,
    resourceTypes.map((r) => ({
      tool: "get_resource_schema_information",
      args: { resource_type: r.type },
      key: r.key,
    })),
  );
}

async function capturePricing() {
  const calls = [
    {
      key: "s3Storage",
      tool: "get_pricing",
      args: {
        service_code: "AmazonS3",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Storage" },
          { Type: "TERM_MATCH", Field: "usagetype", Value: "TimedStorage-ByteHrs" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "ec2T3Micro",
      tool: "get_pricing",
      args: {
        service_code: "AmazonEC2",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Compute Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.micro" },
          { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
          { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
          { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
          { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "ec2T3Small",
      tool: "get_pricing",
      args: {
        service_code: "AmazonEC2",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Compute Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "t3.small" },
          { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
          { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
          { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
          { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "ec2M5Large",
      tool: "get_pricing",
      args: {
        service_code: "AmazonEC2",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Compute Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "m5.large" },
          { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
          { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
          { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
          { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "rdsT3MicroPostgres",
      tool: "get_pricing",
      args: {
        service_code: "AmazonRDS",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "db.t3.micro" },
          { Type: "TERM_MATCH", Field: "databaseEngine", Value: "PostgreSQL" },
          { Type: "TERM_MATCH", Field: "deploymentOption", Value: "Single-AZ" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "rdsT3MicroMysql",
      tool: "get_pricing",
      args: {
        service_code: "AmazonRDS",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "db.t3.micro" },
          { Type: "TERM_MATCH", Field: "databaseEngine", Value: "MySQL" },
          { Type: "TERM_MATCH", Field: "deploymentOption", Value: "Single-AZ" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "rdsR6gLargeAuroraPostgres",
      tool: "get_pricing",
      args: {
        service_code: "AmazonRDS",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "db.r6g.large" },
          { Type: "TERM_MATCH", Field: "databaseEngine", Value: "Aurora PostgreSQL" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "rdsR6gLargeAuroraMysql",
      tool: "get_pricing",
      args: {
        service_code: "AmazonRDS",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "db.r6g.large" },
          { Type: "TERM_MATCH", Field: "databaseEngine", Value: "Aurora MySQL" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "rdsT3MicroMariadb",
      tool: "get_pricing",
      args: {
        service_code: "AmazonRDS",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Database Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "db.t3.micro" },
          { Type: "TERM_MATCH", Field: "databaseEngine", Value: "MariaDB" },
          { Type: "TERM_MATCH", Field: "deploymentOption", Value: "Single-AZ" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    {
      key: "ssmParameter",
      tool: "get_pricing",
      args: {
        service_code: "AWSSystemsManager",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "AWS Systems Manager" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
    // Edge case: nonexistent service for emptyData
    {
      key: "emptyData",
      tool: "get_pricing",
      args: {
        service_code: "AmazonEC2",
        region: "us-east-1",
        filters: [
          { Type: "TERM_MATCH", Field: "productFamily", Value: "Compute Instance" },
          { Type: "TERM_MATCH", Field: "instanceType", Value: "z99.nonexistent" },
          { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
        ],
        output_options: { pricing_terms: ["OnDemand"] },
      },
    },
  ];

  return await callMcpServer(
    "aws-pricing-mcp-server",
    "uvx",
    ["--with", "botocore[crt]", MCP_PINS.AWS_PRICING],
    MCP_ENV,
    calls,
  );
}

async function captureDocumentation() {
  const calls = [
    // search_documentation calls
    {
      key: "search-s3BucketName",
      tool: "search_documentation",
      args: { search_phrase: "BucketName AWS::S3::Bucket" },
    },
    {
      key: "search-ec2InstanceType",
      tool: "search_documentation",
      args: { search_phrase: "InstanceType AWS::EC2::Instance" },
    },
    {
      key: "search-lambdaRuntime",
      tool: "search_documentation",
      args: { search_phrase: "Runtime AWS::Lambda::Function" },
    },
    {
      key: "search-rdsEngine",
      tool: "search_documentation",
      args: { search_phrase: "Engine AWS::RDS::DBInstance" },
    },
    {
      key: "search-dynamoDbBillingMode",
      tool: "search_documentation",
      args: { search_phrase: "BillingMode AWS::DynamoDB::Table" },
    },
    // Edge case: search with no results
    {
      key: "search-noResults",
      tool: "search_documentation",
      args: { search_phrase: "zzz_nonexistent_field_xyz_12345" },
    },
    // read_sections calls — URLs will need to be real; use known AWS doc URLs
    {
      key: "readSections-s3BucketName",
      tool: "read_sections",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html",
        section_titles: ["Overview", "Description", "Properties", "Syntax"],
      },
    },
    {
      key: "readSections-ec2InstanceType",
      tool: "read_sections",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ec2-instance.html",
        section_titles: ["Overview", "Description", "Properties", "Syntax"],
      },
    },
    {
      key: "readSections-lambdaRuntime",
      tool: "read_sections",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html",
        section_titles: ["Overview", "Description", "Properties", "Syntax"],
      },
    },
    {
      key: "readSections-rdsEngine",
      tool: "read_sections",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-rds-dbinstance.html",
        section_titles: ["Overview", "Description", "Properties", "Syntax"],
      },
    },
    {
      key: "readSections-dynamoDbBillingMode",
      tool: "read_sections",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dynamodb-table.html",
        section_titles: ["Overview", "Description", "Properties", "Syntax"],
      },
    },
    // read_documentation full page
    {
      key: "readFull-s3Bucket",
      tool: "read_documentation",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html",
      },
    },
    {
      key: "readFull-lambdaFunction",
      tool: "read_documentation",
      args: {
        url: "https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html",
      },
    },
  ];

  return await callMcpServer(
    "aws-documentation-mcp-server",
    "uvx",
    [MCP_PINS.AWS_DOCUMENTATION],
    {}, // No AWS creds needed
    calls,
  );
}

async function captureIamPolicy() {
  const calls = [
    // Simulate checking permissions for S3 bucket creation
    {
      key: "s3BucketAllowed",
      tool: "simulate_principal_policy",
      args: {
        action_names: ["cloudcontrol:CreateResource", "cloudcontrol:GetResourceRequestStatus", "s3:CreateBucket", "s3:PutBucketTagging"],
        resource_arns: ["*"],
      },
    },
    // Simulate checking permissions for EC2 instance (likely missing some)
    {
      key: "ec2InstancePartialDeny",
      tool: "simulate_principal_policy",
      args: {
        action_names: ["cloudcontrol:CreateResource", "ec2:RunInstances", "ec2:CreateTags", "iam:PassRole"],
        resource_arns: ["*"],
      },
    },
    // Simulate checking permissions for Lambda
    {
      key: "lambdaFunctionAllowed",
      tool: "simulate_principal_policy",
      args: {
        action_names: ["cloudcontrol:CreateResource", "lambda:CreateFunction", "lambda:TagResource", "iam:PassRole"],
        resource_arns: ["*"],
      },
    },
  ];

  return await callMcpServer(
    "iam-mcp-server",
    "uvx",
    [MCP_PINS.AWS_IAM, "--readonly"],
    MCP_ENV,
    calls,
  );
}

async function captureWellArchitectedSecurity() {
  // Note: This server analyzes security posture of existing resources.
  // We need real resource ARNs that exist in the account.
  // For capture purposes, use common resource patterns.
  const calls = [
    {
      key: "s3BucketPosture",
      tool: "GetSecurityFindings",
      args: { resource_arn: "arn:aws:s3:::assignee-test-capture-bucket" },
    },
    {
      key: "noFindings",
      tool: "GetSecurityFindings",
      args: { resource_arn: "arn:aws:s3:::nonexistent-bucket-for-test" },
    },
  ];

  return await callMcpServer(
    "well-architected-security-mcp-server",
    "uvx",
    [MCP_PINS.AWS_WA_SECURITY],
    MCP_ENV,
    calls,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("MCP Response Capture Script");
  console.log(`Output: ${OUT_DIR}\n`);
  console.log("Credentials loaded:", process.env.ASSIGNEE_READER_ACCESS_KEY_ID ? "✓" : "✗");

  try {
    await captureCfnSchemas();
  } catch (e) {
    console.error("cfn-mcp-server capture failed:", e.message);
  }

  try {
    await capturePricing();
  } catch (e) {
    console.error("aws-pricing-mcp-server capture failed:", e.message);
  }

  try {
    await captureDocumentation();
  } catch (e) {
    console.error("aws-documentation-mcp-server capture failed:", e.message);
  }

  try {
    await captureIamPolicy();
  } catch (e) {
    console.error("iam-mcp-server capture failed:", e.message);
  }

  try {
    await captureWellArchitectedSecurity();
  } catch (e) {
    console.error("well-architected-security-mcp-server capture failed:", e.message);
  }

  console.log("\n═══ Capture Complete ═══");
  console.log("Review captured responses in:", OUT_DIR);
}

main().catch(console.error);
