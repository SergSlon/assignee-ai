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
import type { SecurityFinding } from "../types/fix-finding.js";

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
      const raw = JSON.parse(unwrapMcpText(result));
      // v0.1.7: real server wraps payload in { result: {...} }
      const posture = raw?.result ?? raw;
      // gracefully return empty when the service is disabled.
      if (posture.enabled === false) return;
      const rawFindings = Array.isArray(posture.findings)
        ? posture.findings
        : [];
      // Story 46.2: tag every WA Security MCP response "mcp" so the
      // display layer can render the provenance suffix. The current MCP
      // server payload doesn't carry a `source` field of its own, so we
      // add one at this boundary — but defer to a server-supplied
      // `source` if a future MCP version starts emitting richer
      // provenance (per Edge F8 / Blind 5: don't blindly clobber).
      const criticalHighFindings = (rawFindings as SecurityFinding[])
        .filter(
          (f) =>
            f.severity === Severity.CRITICAL || f.severity === Severity.HIGH,
        )
        .map(
          (f) =>
            ({ ...f, source: f.source ?? "mcp" }) satisfies SecurityFinding,
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
