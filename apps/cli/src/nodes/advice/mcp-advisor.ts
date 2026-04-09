/**
 * MCP-powered advisor — queries real AWS data for contextual advice.
 * All queries are parallel with 3s timeout, all gracefully degrade.
 *
 * @see Story 40.2 — MCP Context Enrichment
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import { AWS_REGION } from "../../config/constants.js";
import { withTimeout } from "../../utils/timeout.js";

const MCP_ADVICE_TIMEOUT_MS = 3_000;

/** Context gathered from MCP servers to enrich the LLM advice prompt. */
export interface McpAdviceContext {
  pricingSnippet?: string;
  docSnippet?: string;
  securitySnippet?: string;
}

/**
 * Queries MCP servers in parallel for real-time advice context.
 * Returns whatever data is available within 3s. Never throws.
 */
export async function gatherMcpAdviceContext(
  resourceType: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<McpAdviceContext> {
  const [pricing, docs, security] = await Promise.allSettled([
    fetchPricingContext(resourceType, desiredState, tools),
    fetchDocContext(resourceType, tools),
    fetchSecurityContext(resourceType, desiredState, tools),
  ]);

  return {
    pricingSnippet: pricing.status === "fulfilled" ? pricing.value : undefined,
    docSnippet: docs.status === "fulfilled" ? docs.value : undefined,
    securitySnippet:
      security.status === "fulfilled" ? security.value : undefined,
  };
}

async function fetchPricingContext(
  resourceType: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<string | undefined> {
  const tool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!tool) return undefined;

  // Build a simple pricing query based on resource type
  const serviceCode = resourceTypeToServiceCode(resourceType);
  if (!serviceCode) return undefined;

  const result = await withTimeout(
    tool.invoke({
      service_code: serviceCode,
      region: AWS_REGION,
      filters: [],
      output_options: { pricing_terms: ["OnDemand"], max_results: 3 },
    }),
    MCP_ADVICE_TIMEOUT_MS,
  );

  if (!result) return undefined;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  // Truncate to keep prompt size reasonable
  return text.length > 500 ? text.slice(0, 500) + "..." : text;
}

async function fetchDocContext(
  resourceType: string,
  tools: StructuredTool[],
): Promise<string | undefined> {
  const tool = tools.find((t) => t.name === ToolName.SEARCH_DOCUMENTATION);
  if (!tool) return undefined;

  const shortType = resourceType.split("::").pop() ?? resourceType;
  const result = await withTimeout(
    tool.invoke({
      search_phrase: `${shortType} best practices security`,
      max_results: 2,
    }),
    MCP_ADVICE_TIMEOUT_MS,
  );

  if (!result) return undefined;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 500 ? text.slice(0, 500) + "..." : text;
}

async function fetchSecurityContext(
  resourceType: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<string | undefined> {
  const tool = tools.find((t) => t.name === ToolName.ANALYZE_SECURITY_POSTURE);
  if (!tool) return undefined;

  const result = await withTimeout(
    tool.invoke({
      resource_type: resourceType,
      configuration: desiredState,
    }),
    MCP_ADVICE_TIMEOUT_MS,
  );

  if (!result) return undefined;
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 500 ? text.slice(0, 500) + "..." : text;
}

/**
 * Maps CloudFormation resource type to AWS Pricing API service code for
 * LLM advice enrichment.
 *
 * Only PAID / workload-dependent types are listed — free wiring types
 * (VPC, Subnet, SecurityGroup, IAM::Role, Events::Rule, Events::Connection,
 * SNS::Subscription, etc.) deliberately return undefined so the advisor
 * skips the MCP call instead of wasting budget on a query that surfaces
 * no useful number.
 *
 * NOTE: This map drifted out of sync with SUPPORTED_TYPES_ARRAY when
 * Sprint G → A13 landed new paid types without updating the advisor.
 * The 2026-04-09 (f) audit pass caught it — every type added since
 * Sprint G (EFS::FileSystem, Events::EventBus, Events::ApiDestination,
 * KMS::Key) is now present. mcp-advisor.test.ts installs a CI-gate
 * that forces every new SUPPORTED_TYPES_ARRAY entry to be explicitly
 * categorized as mapped (paid) or exempt (free wiring), so the next
 * type promotion cannot silently skip this step.
 *
 * Exported for testing — do not call directly from production code
 * outside this file. The public API is `gatherMcpAdviceContext`.
 */
export function resourceTypeToServiceCode(
  resourceType: string,
): string | undefined {
  const map: Record<string, string> = {
    "AWS::EC2::Instance": "AmazonEC2",
    "AWS::RDS::DBInstance": "AmazonRDS",
    "AWS::S3::Bucket": "AmazonS3",
    "AWS::Lambda::Function": "AWSLambda",
    "AWS::DynamoDB::Table": "AmazonDynamoDB",
    "AWS::EC2::NatGateway": "AmazonEC2",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "ElasticLoadBalancing",
    // SQS uses AmazonSQS to match the SC.SQS constant in
    // packages/core/src/pricing/filter-constants.ts. The filter
    // constants are the single source of truth — every other
    // SQS-related call site (decomposer, strategy, integration
    // tests) reads from there. The advisor used to drift to the
    // legacy "AWSQueueService" code; the (f) audit caught it.
    "AWS::SQS::Queue": "AmazonSQS",
    "AWS::SNS::Topic": "AmazonSNS",
    "AWS::ECS::Cluster": "AmazonECS",
    "AWS::CloudWatch::Alarm": "AmazonCloudWatch",
    "AWS::Logs::LogGroup": "AmazonCloudWatch",
    "AWS::SecretsManager::Secret": "AWSSecretsManager",
    "AWS::ECR::Repository": "AmazonECR",
    "AWS::ApiGatewayV2::Api": "AmazonApiGateway",
    // A1 (2026-04-08): EFS storage ($0.30/GB-mo) + optional
    // provisioned throughput (~$6/MiB-s-mo).
    "AWS::EFS::FileSystem": "AmazonEFS",
    // A9 (2026-04-09): EventBridge custom event bus
    // ($1/M events PUBLISHED to the bus).
    "AWS::Events::EventBus": "AmazonEventBridge",
    // A13 (2026-04-09): EventBridge API destination
    // ($0.20 per 1M invocations).
    "AWS::Events::ApiDestination": "AmazonEventBridge",
    // A11 (2026-04-09): KMS customer-managed keys
    // ($1/key-month prorated, plus API request fees).
    "AWS::KMS::Key": "awskms",
    // A14 (2026-04-09): CloudFront::Distribution
    // (data transfer out + HTTPS requests, tiered by geography).
    "AWS::CloudFront::Distribution": "AmazonCloudFront",
  };
  return map[resourceType];
}
