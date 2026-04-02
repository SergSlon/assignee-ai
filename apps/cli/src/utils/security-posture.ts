/**
 * Post-provision security posture check (Story 19.2).
 * Non-blocking: findings are informational warnings only.
 * Gracefully degrades if the MCP server is unavailable or times out.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { renderSecurityWarnings } from "./display.js";
import { ToolName } from "../constants/tools.js";
import { SECURITY_CHECK_TIMEOUT_MS } from "../config/constants.js";
import { unwrapMcpText } from "./mcp.js";
import { withTimeout } from "./timeout.js";
import { log, LOG_ACTIONS } from "./logger.js";

export async function checkSecurityPosture(
  resourceArn: string,
  tools: StructuredTool[],
  runId: string,
): Promise<void> {
  const securityTool = tools.find(
    (t) => t.name === ToolName.ANALYZE_SECURITY_POSTURE,
  );
  if (!securityTool) return;

  try {
    const result = await withTimeout(
      securityTool.invoke({
        resource_arn: resourceArn,
      }),
      SECURITY_CHECK_TIMEOUT_MS,
    );
    if (result !== null) {
      const posture = JSON.parse(unwrapMcpText(result));
      const criticalHighFindings = (posture.findings ?? []).filter(
        (f: any) => f.severity === "CRITICAL" || f.severity === "HIGH",
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
