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
 * Preserves REG-N3 (bp-evaluator Wave 6c): the enricher runs AFTER
 * the cache-hit check, so cache warmers never trigger MCP calls.
 *
 * @see Story 40.2 — MCP Best Practices Enrichment
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { BPFinding } from "@assignee/best-practices";
import { STORAGE_RESOURCE_TYPES, NETWORK_RESOURCE_TYPES } from "./types.js";
import {
  querySecurityPosture,
  queryStorageEncryption,
  queryNetworkSecurity,
  queryDocsBestPractices,
} from "./mcp-queries.js";

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
