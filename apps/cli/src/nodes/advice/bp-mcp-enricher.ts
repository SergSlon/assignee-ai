/**
 * Best Practices MCP Enricher — validates static BP rules against live AWS data.
 *
 * Static YAML rules catch known patterns but can be outdated.
 * This module queries MCP servers to:
 * 1. Validate that static BP recommendations are still current
 * 2. Discover NEW best practices not in our YAML (via AWS docs MCP)
 * 3. Check security posture against Well-Architected framework (live)
 *
 * Non-blocking: if MCP is unavailable, static BPs are still used.
 *
 * @see Story 40.2 — MCP Best Practices Enrichment
 */

import type { StructuredTool } from "@langchain/core/tools";
import type {
  BPFinding,
  BPSeverity,
  BPCategory,
} from "@assignee/best-practices";
import { ToolName } from "../../constants/tools.js";
import { AWS_REGION } from "../../config/constants.js";
import { withTimeout } from "../../utils/timeout.js";

const MCP_BP_TIMEOUT_MS = 3_000;

/** Resource types that should trigger CheckStorageEncryption. */
const STORAGE_RESOURCE_TYPES = new Set([
  "AWS::S3::Bucket",
  "AWS::RDS::DBInstance",
  "AWS::DynamoDB::Table",
  "AWS::EFS::FileSystem",
  "AWS::Logs::LogGroup",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::SecretsManager::Secret",
  "AWS::ECR::Repository",
]);

/** Resource types that should trigger CheckNetworkSecurity. */
const NETWORK_RESOURCE_TYPES = new Set([
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::ApiGatewayV2::Api",
  "AWS::CloudFront::Distribution",
  "AWS::EC2::Instance",
  "AWS::EC2::SecurityGroup",
  "AWS::RDS::DBInstance",
]);

/**
 * Enriches static BP findings with live MCP data.
 * - Queries Well-Architected Security MCP for real-time posture analysis
 * - Queries CheckStorageEncryption for storage resource types
 * - Queries CheckNetworkSecurity for network resource types
 * - Queries Documentation MCP for latest best practice guidance
 * - Returns additional findings discovered by MCP that static rules missed
 */
export async function enrichBpWithMcp(
  resourceType: string,
  desiredState: Record<string, unknown>,
  staticFindings: BPFinding[],
  tools: StructuredTool[],
): Promise<BPFinding[]> {
  const additionalFindings: BPFinding[] = [];

  const [securityResult, storageResult, networkResult, docsResult] =
    await Promise.allSettled([
      querySecurityPosture(resourceType, desiredState, tools),
      STORAGE_RESOURCE_TYPES.has(resourceType)
        ? queryStorageEncryption(tools)
        : Promise.resolve([]),
      NETWORK_RESOURCE_TYPES.has(resourceType)
        ? queryNetworkSecurity(tools)
        : Promise.resolve([]),
      queryDocsBestPractices(resourceType, tools),
    ]);

  // Helper: merge findings from a settled result into the output list
  function mergeFindings(
    result: PromiseSettledResult<BPFinding[]>,
    dedupBy: "propertyPath" | "practiceId",
  ): void {
    if (result.status !== "fulfilled" || !result.value) return;
    for (const finding of result.value) {
      const key = finding[dedupBy];
      const alreadyCovered =
        key !== undefined &&
        (staticFindings.some((sf) => sf[dedupBy] === key) ||
          additionalFindings.some((af) => af[dedupBy] === key));
      if (!alreadyCovered) {
        additionalFindings.push(finding);
      }
    }
  }

  mergeFindings(securityResult, "propertyPath");
  mergeFindings(storageResult, "practiceId");
  mergeFindings(networkResult, "practiceId");
  mergeFindings(docsResult, "practiceId");

  return additionalFindings;
}

async function querySecurityPosture(
  _resourceType: string,
  _desiredState: Record<string, unknown>,
  tools: StructuredTool[],
): Promise<BPFinding[]> {
  const tool = tools.find((t) => t.name === ToolName.GET_SECURITY_FINDINGS);
  if (!tool) return [];

  const result = await withTimeout(
    tool.invoke({
      service: "securityhub",
      region: AWS_REGION,
      max_findings: 20,
    }),
    MCP_BP_TIMEOUT_MS,
  );

  if (!result) return [];

  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const outer = JSON.parse(text) as Record<string, unknown>;
    // v0.1.7: real server wraps payload in { result: {...} }
    const parsed = (outer?.["result"] ?? outer) as {
      enabled?: boolean;
      findings?: Array<{
        severity?: string;
        title?: string;
        recommendation?: string;
        property?: string;
      }>;
    };

    // v0.1.7: gracefully return empty when security service is disabled.
    if (parsed.enabled === false) return [];
    if (!parsed.findings || !Array.isArray(parsed.findings)) return [];

    return parsed.findings.map(
      (f): BPFinding => ({
        practiceId: `MCP-SEC-${(f.title ?? "unknown").replace(/\s+/g, "-").slice(0, 30)}`,
        title: f.title ?? "Security finding from Well-Architected review",
        severity: mapMcpSeverity(f.severity),
        category: "security" as BPCategory,
        message: f.recommendation ?? "",
        remediation: f.recommendation ?? "",
        blocking: false,
        propertyPath: f.property,
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Queries WA Security CheckStorageEncryption for data-at-rest findings.
 * Only called for storage resource types (S3, RDS, DynamoDB, etc.).
 */
async function queryStorageEncryption(
  tools: StructuredTool[],
): Promise<BPFinding[]> {
  const tool = tools.find((t) => t.name === ToolName.CHECK_STORAGE_ENCRYPTION);
  if (!tool) return [];

  const result = await withTimeout(
    tool.invoke({ region: AWS_REGION }),
    MCP_BP_TIMEOUT_MS,
  );
  if (!result) return [];

  return parseWaSecurityFindings(result, "MCP-STOR");
}

/**
 * Queries WA Security CheckNetworkSecurity for data-in-transit findings.
 * Only called for network resource types (ELBv2, API Gateway, CloudFront, etc.).
 */
async function queryNetworkSecurity(
  tools: StructuredTool[],
): Promise<BPFinding[]> {
  const tool = tools.find((t) => t.name === ToolName.CHECK_NETWORK_SECURITY);
  if (!tool) return [];

  const result = await withTimeout(
    tool.invoke({ region: AWS_REGION }),
    MCP_BP_TIMEOUT_MS,
  );
  if (!result) return [];

  return parseWaSecurityFindings(result, "MCP-NET");
}

/**
 * Shared parser for WA Security findings from CheckStorageEncryption
 * and CheckNetworkSecurity. Handles both `findings` and `resource_details` arrays.
 */
function parseWaSecurityFindings(
  result: unknown,
  practicePrefix: string,
): BPFinding[] {
  try {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const outer = JSON.parse(text) as Record<string, unknown>;
    const parsed = (outer?.["result"] ?? outer) as Record<string, unknown>;

    // Handle both formats: findings[] or resource_details[]
    const items =
      (parsed["findings"] as unknown[]) ??
      (parsed["resource_details"] as unknown[]) ??
      [];
    if (!Array.isArray(items)) return [];

    return items
      .filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object",
      )
      .flatMap((item) => {
        // resource_details format: {resource_arn, compliant, issues[], recommendations[]}
        if (item["compliant"] === true) return []; // Skip compliant resources
        const issues = item["issues"] as string[] | undefined;
        const recommendations = item["recommendations"] as string[] | undefined;
        // Include resource ARN suffix in practiceId to avoid collisions when
        // multiple resources have the same issue text.
        const arnSuffix =
          String(item["resource_arn"] ?? "")
            .split(/[:/]/)
            .pop() ?? "";
        if (issues && Array.isArray(issues)) {
          return issues.map(
            (issue, i): BPFinding => ({
              practiceId: `${practicePrefix}-${arnSuffix ? arnSuffix + "-" : ""}${issue.replace(/\s+/g, "-").slice(0, 25)}`,
              title: issue,
              severity: mapMcpSeverity(item["severity"] as string | undefined),
              category: "security" as BPCategory,
              message: recommendations?.[i] ?? issue,
              remediation: recommendations?.[i] ?? "",
              blocking: false,
            }),
          );
        }

        // findings format: {severity, title, recommendation, property}
        const title = item["title"] as string | undefined;
        if (title) {
          return [
            {
              practiceId: `${practicePrefix}-${title.replace(/\s+/g, "-").slice(0, 25)}`,
              title,
              severity: mapMcpSeverity(item["severity"] as string | undefined),
              category: "security" as BPCategory,
              message: (item["recommendation"] as string) ?? "",
              remediation: (item["recommendation"] as string) ?? "",
              blocking: false,
              propertyPath: item["property"] as string | undefined,
            },
          ];
        }

        return [];
      });
  } catch {
    return [];
  }
}

async function queryDocsBestPractices(
  resourceType: string,
  tools: StructuredTool[],
): Promise<BPFinding[]> {
  const tool = tools.find((t) => t.name === ToolName.SEARCH_DOCUMENTATION);
  if (!tool) return [];

  const shortType = resourceType.split("::").pop() ?? resourceType;
  const result = await withTimeout(
    tool.invoke({
      search_phrase: `${shortType} security best practices 2026`,
      limit: 3,
    }),
    MCP_BP_TIMEOUT_MS,
  );

  if (!result) return [];

  // Docs MCP returns search results, not structured findings.
  // We don't generate BP findings from docs — that would require LLM interpretation.
  // Instead, we return empty and let the advice-generator's LLM handle doc synthesis.
  return [];
}

function mapMcpSeverity(severity: string | undefined): BPSeverity {
  switch (severity?.toUpperCase()) {
    case "CRITICAL":
      return "CRITICAL";
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
      return "MEDIUM";
    default:
      return "INFO";
  }
}
