/**
 * Per-MCP-tool query helpers for bp-mcp-enricher.
 *
 * Each helper invokes a single MCP tool under a shared timeout and
 * returns `BPFinding[]` in the enricher's dedup-ready shape. The
 * tool-name constants (`ToolName.*`) are the load-bearing contracts —
 * do NOT rewrite them to new names without updating the MCP server.
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { BPFinding, BPCategory } from "@assignee/best-practices";
import { ToolName } from "@/constants/tools.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { withTimeout } from "@/utils/timeout.js";
import { MCP_BP_TIMEOUT_MS, mapMcpSeverity } from "./types.js";
import { parseWaSecurityFindings } from "./wa-security-parser.js";

export async function querySecurityPosture(
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
export async function queryStorageEncryption(
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
export async function queryNetworkSecurity(
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

export async function queryDocsBestPractices(
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
