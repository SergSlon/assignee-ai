/**
 * preflight_guard node — cost estimation + basic validation gate.
 * Pricing query has a 500ms hard timeout (non-blocking: never delays the plan).
 * SaaS policy validation is Epic 4; POC always passes.
 *
 * @see Story 1-7
 */

import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { log } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const PRICING_TIMEOUT_MS = 500;

/** Maps resource type → AWS Pricing service code (or "Free" to skip). */
const PRICING_SERVICE_MAP: Record<string, string | "Free"> = {
  "AWS::S3::Bucket": "AmazonS3",
  "AWS::SSM::Parameter": "AWSSystemsManager",
  "AWS::IAM::Role": "Free",
};

export async function preflightGuardNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  const serviceCode = PRICING_SERVICE_MAP[state.resourceType];
  let costEstimate = "N/A";

  if (serviceCode === "Free") {
    costEstimate = "Free";
  } else if (serviceCode && tools) {
    const pricingTool = tools.find(
      (t) =>
        t.name.toLowerCase().includes("pricing") ||
        t.name.toLowerCase().includes("price"),
    );
    if (pricingTool) {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), PRICING_TIMEOUT_MS),
        );
        const query = pricingTool.invoke({
          serviceCode,
          region: process.env["AWS_REGION"] ?? "eu-west-1",
        });
        const result = await Promise.race([query, timeout]);
        if (result !== null) {
          const parsed =
            typeof result === "string"
              ? (JSON.parse(result) as Record<string, unknown>)
              : result;
          const estimate = (parsed as Record<string, unknown>)?.[
            "estimatedMonthlyCost"
          ];
          costEstimate =
            typeof estimate === "string" ? estimate : "~$0.01/month";
        }
        // null means timeout — leave costEstimate as 'N/A'
      } catch {
        // Non-blocking: pricing failure never blocks the plan
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: "pricing_unavailable",
          resourceType: state.resourceType,
        });
      }
    }
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: "preflight_completed",
    costEstimate,
    resourceType: state.resourceType,
  });

  return {
    estimatedMonthlyCost: costEstimate,
    preflightPassed: true,
  };
}
