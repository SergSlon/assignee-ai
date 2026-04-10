/**
 * Post-provision security posture check (Story 19.2).
 * Non-blocking: findings are informational warnings only.
 * Gracefully degrades if the MCP server is unavailable or times out.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { Severity } from "@assignee/best-practices";
import { renderSecurityWarnings } from "./display.js";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION, SECURITY_CHECK_TIMEOUT_MS } from "../config/constants.js";
import { unwrapMcpText } from "./mcp.js";
import { withTimeout } from "./timeout.js";
import { log, LOG_ACTIONS } from "./logger.js";
import type { SecurityFinding } from "../services/graph-state.js";

export async function checkSecurityPosture(
  resourceArn: string,
  tools: StructuredTool[],
  runId: string,
): Promise<void> {
  const securityTool = tools.find(
    (t) => t.name === ToolName.GET_SECURITY_FINDINGS,
  );
  if (!securityTool) return;

  try {
    const result = await withTimeout(
      securityTool.invoke({
        service: "securityhub",
        region: AWS_REGION,
        max_findings: 10,
        severity_filter: "HIGH",
      }),
      SECURITY_CHECK_TIMEOUT_MS,
    );
    if (result !== null) {
      const posture = JSON.parse(unwrapMcpText(result));
      // v0.1.7: response has { enabled, findings, summary } —
      // gracefully return empty when the service is disabled.
      if (posture.enabled === false) return;
      const rawFindings = Array.isArray(posture.findings)
        ? posture.findings
        : [];
      const criticalHighFindings = (rawFindings as SecurityFinding[]).filter(
        (f) => f.severity === Severity.CRITICAL || f.severity === Severity.HIGH,
      );
      if (criticalHighFindings.length > 0) {
        renderSecurityWarnings(resourceArn, criticalHighFindings);
      }
    }
  } catch {
    process.stderr.write(
      "Security posture check skipped (MCP server unavailable)\n",
    );
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.SECURITY_CHECK_SKIPPED,
      extras: { resourceArn },
    });
  }
}
