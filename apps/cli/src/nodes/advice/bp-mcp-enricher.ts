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

/**
 * Enriches static BP findings with live MCP data.
 * - Queries Well-Architected Security MCP for real-time posture analysis
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

  const [securityResult, docsResult] = await Promise.allSettled([
    querySecurityPosture(resourceType, desiredState, tools),
    queryDocsBestPractices(resourceType, tools),
  ]);

  // Merge security posture findings (from WA-Security MCP)
  if (securityResult.status === "fulfilled" && securityResult.value) {
    for (const finding of securityResult.value) {
      // Skip if static rules already cover this
      const alreadyCovered = staticFindings.some(
        (sf) => sf.propertyPath === finding.propertyPath,
      );
      if (!alreadyCovered) {
        additionalFindings.push(finding);
      }
    }
  }

  // Merge documentation-based findings (from AWS Docs MCP)
  if (docsResult.status === "fulfilled" && docsResult.value) {
    for (const finding of docsResult.value) {
      const alreadyCovered = staticFindings.some(
        (sf) => sf.practiceId === finding.practiceId,
      );
      if (!alreadyCovered) {
        additionalFindings.push(finding);
      }
    }
  }

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
