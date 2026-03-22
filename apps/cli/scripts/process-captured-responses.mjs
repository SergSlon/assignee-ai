#!/usr/bin/env node
/**
 * Process captured MCP responses into trimmed fixture-ready JSON.
 * Reads from captured-responses/, writes to processed-responses/.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPTURE_DIR = resolve(__dirname, "captured-responses");
const OUT_DIR = resolve(__dirname, "processed-responses");
mkdirSync(OUT_DIR, { recursive: true });

function readCapture(filename) {
  return JSON.parse(readFileSync(resolve(CAPTURE_DIR, filename), "utf-8"));
}

function writeProcessed(filename, data) {
  writeFileSync(resolve(OUT_DIR, filename), JSON.stringify(data, null, 2));
}

// ── Schema processing: extract and trim ─────────────────────────────────────

function trimSchemaProperties(props, depth = 0, maxDepth = 2) {
  if (!props || typeof props !== "object" || depth > maxDepth) return {};
  const result = {};
  for (const [key, val] of Object.entries(props)) {
    if (typeof val !== "object" || val === null) {
      result[key] = val;
      continue;
    }
    const trimmed = {};
    // Keep type, description, enum, default, minimum, maximum, pattern
    for (const field of ["type", "description", "enum", "default", "minimum", "maximum", "pattern", "minLength", "maxLength", "insertionOrder"]) {
      if (field in val) trimmed[field] = val[field];
    }
    // Keep $ref
    if ("$ref" in val) trimmed["$ref"] = val["$ref"];
    // Keep items type
    if ("items" in val && typeof val.items === "object") {
      trimmed.items = { type: val.items.type || val.items["$ref"] ? undefined : "string" };
      if (val.items["$ref"]) trimmed.items["$ref"] = val.items["$ref"];
      if (val.items.type) trimmed.items.type = val.items.type;
    }
    // Recurse into nested properties if within depth
    if ("properties" in val && depth < maxDepth) {
      trimmed.properties = trimSchemaProperties(val.properties, depth + 1, maxDepth);
    }
    result[key] = trimmed;
  }
  return result;
}

function processSchema(filename, key) {
  const captured = readCapture(filename);
  const content = captured.content[0];

  if (captured.isError) {
    // Error response — keep as-is
    writeProcessed(`schema-${key}.json`, { type: "text", text: content.text });
    console.log(`  ✓ schema-${key} (error response)`);
    return;
  }

  const schema = JSON.parse(content.text);
  const totalProps = Object.keys(schema.properties || {}).length;

  // Build trimmed schema
  const trimmed = {
    typeName: schema.typeName,
    description: schema.description,
    properties: trimSchemaProperties(schema.properties),
    required: schema.required || [],
    readOnlyProperties: schema.readOnlyProperties,
    primaryIdentifier: schema.primaryIdentifier,
    additionalProperties: schema.additionalProperties,
  };

  // Clean up undefined fields
  if (!trimmed.readOnlyProperties) delete trimmed.readOnlyProperties;

  const result = { type: "text", text: JSON.stringify(trimmed) };
  writeProcessed(`schema-${key}.json`, result);
  console.log(`  ✓ schema-${key} (${totalProps} props → trimmed)`);
}

// ── Pricing processing: extract content[0] ──────────────────────────────────

function processPricing(filename, key) {
  const captured = readCapture(filename);
  const content = captured.content[0];
  const innerJson = JSON.parse(content.text);

  // Trim product attributes to essential ones only
  if (innerJson.data) {
    for (const item of innerJson.data) {
      if (item.product?.attributes) {
        const attrs = item.product.attributes;
        const essential = {};
        for (const field of [
          "instanceType", "operatingSystem", "tenancy", "regionCode",
          "productFamily", "usagetype", "databaseEngine", "deploymentOption",
          "capacitystatus", "preInstalledSw", "servicecode", "servicename",
          "memory", "vcpu", "storage", "currentGeneration", "instanceFamily",
        ]) {
          if (field in attrs) essential[field] = attrs[field];
        }
        item.product.attributes = essential;
      }
    }
  }

  const result = { type: "text", text: JSON.stringify(innerJson) };
  writeProcessed(`pricing-${key}.json`, result);
  const dataCount = innerJson.data?.length ?? 0;
  console.log(`  ✓ pricing-${key} (${dataCount} items, status=${innerJson.status})`);
}

// ── Doc search processing: extract structuredContent ────────────────────────

function processDocSearch(filename, key) {
  const captured = readCapture(filename);
  const sc = captured.structuredContent;

  // Trim to first 3 results with essential fields only
  const trimmed = {
    search_results: (sc.search_results || []).slice(0, 3).map((r) => ({
      rank_order: r.rank_order,
      url: r.url,
      title: r.title,
      context: r.context,
    })),
  };

  writeProcessed(`docSearch-${key}.json`, trimmed);
  const totalResults = sc.search_results?.length ?? 0;
  console.log(`  ✓ docSearch-${key} (${totalResults} results → ${trimmed.search_results.length} kept)`);
}

// ── Doc read processing: extract content[0] text ────────────────────────────

function processDocRead(filename, key, maxChars = 2000) {
  const captured = readCapture(filename);
  const content = captured.content[0];
  let text = content.text;

  // Truncate if too long
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + "\n\n[Content truncated for test fixture]";
  }

  const result = { type: "text", text };
  writeProcessed(`docRead-${key}.json`, result);
  console.log(`  ✓ docRead-${key} (${content.text.length} chars → ${text.length})`);
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log("Processing captured MCP responses...\n");

console.log("═══ CFN Schemas ═══");
processSchema("cfn-mcp-server--s3Bucket.json", "s3Bucket");
processSchema("cfn-mcp-server--ec2Instance.json", "ec2Instance");
processSchema("cfn-mcp-server--lambdaFunction.json", "lambdaFunction");
processSchema("cfn-mcp-server--rdsDbInstance.json", "rdsDbInstance");
processSchema("cfn-mcp-server--iamRole.json", "iamRole");
processSchema("cfn-mcp-server--dynamoDbTable.json", "dynamoDbTable");
processSchema("cfn-mcp-server--ssmParameter.json", "ssmParameter");
processSchema("cfn-mcp-server--generic.json", "generic");

console.log("\n═══ Pricing ═══");
processPricing("aws-pricing-mcp-server--s3Storage.json", "s3Storage");
processPricing("aws-pricing-mcp-server--ec2T3Micro.json", "ec2T3Micro");
processPricing("aws-pricing-mcp-server--ec2T3Small.json", "ec2T3Small");
processPricing("aws-pricing-mcp-server--ec2M5Large.json", "ec2M5Large");
processPricing("aws-pricing-mcp-server--rdsT3MicroPostgres.json", "rdsT3MicroPostgres");
processPricing("aws-pricing-mcp-server--rdsT3MicroMysql.json", "rdsT3MicroMysql");
processPricing("aws-pricing-mcp-server--rdsR6gLargeAuroraPostgres.json", "rdsR6gLargeAuroraPostgres");
processPricing("aws-pricing-mcp-server--rdsR6gLargeAuroraMysql.json", "rdsR6gLargeAuroraMysql");
processPricing("aws-pricing-mcp-server--rdsT3MicroMariadb.json", "rdsT3MicroMariadb");
processPricing("aws-pricing-mcp-server--ssmParameter.json", "ssmParameter");
processPricing("aws-pricing-mcp-server--emptyData.json", "emptyData");

console.log("\n═══ Doc Search ═══");
processDocSearch("aws-documentation-mcp-server--search-s3BucketName.json", "s3BucketName");
processDocSearch("aws-documentation-mcp-server--search-ec2InstanceType.json", "ec2InstanceType");
processDocSearch("aws-documentation-mcp-server--search-lambdaRuntime.json", "lambdaRuntime");
processDocSearch("aws-documentation-mcp-server--search-rdsEngine.json", "rdsEngine");
processDocSearch("aws-documentation-mcp-server--search-dynamoDbBillingMode.json", "dynamoDbBillingMode");
processDocSearch("aws-documentation-mcp-server--search-noResults.json", "noResults");

console.log("\n═══ Doc Read Sections ═══");
processDocRead("aws-documentation-mcp-server--readSections-s3BucketName.json", "readSections-s3BucketName");
processDocRead("aws-documentation-mcp-server--readSections-ec2InstanceType.json", "readSections-ec2InstanceType");
processDocRead("aws-documentation-mcp-server--readSections-lambdaRuntime.json", "readSections-lambdaRuntime");
processDocRead("aws-documentation-mcp-server--readSections-rdsEngine.json", "readSections-rdsEngine");
processDocRead("aws-documentation-mcp-server--readSections-dynamoDbBillingMode.json", "readSections-dynamoDbBillingMode");

console.log("\n═══ Doc Read Full ═══");
processDocRead("aws-documentation-mcp-server--readFull-s3Bucket.json", "readFull-s3Bucket", 3000);
processDocRead("aws-documentation-mcp-server--readFull-lambdaFunction.json", "readFull-lambdaFunction", 3000);

console.log("\n✅ Processing complete. Check:", OUT_DIR);
