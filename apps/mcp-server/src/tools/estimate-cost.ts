/**
 * estimate_cost MCP tool — estimates monthly cost for a resource configuration.
 *
 * Lightweight pricing lookup — does NOT run the full LangGraph pipeline.
 * Uses the PricingStrategyRegistry from @assignee/core for local estimation
 * and keyword-based resource type classification.
 *
 * @see Epic 20, ADR-008, Story 20.4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  classifyResourceType,
  estimateCostForResource,
} from "../services/cost-estimator.js";
import { DEFAULT_AWS_REGION } from "@assignee/core";

export const estimateCostParams = {
  description: z
    .string()
    .describe(
      "Natural language description of the resource (e.g., 'RDS PostgreSQL db.t3.micro in us-east-1')",
    ),
  resourceType: z
    .string()
    .optional()
    .describe(
      "AWS CloudFormation resource type (e.g. 'AWS::S3::Bucket', 'AWS::Lambda::Function'). If provided, overrides classification from description.",
    ),
  desiredState: z
    .record(z.unknown())
    .optional()
    .describe(
      "Desired-state JSON for the resource. If omitted, returns a baseline estimate for the resource type.",
    ),
  region: z
    .string()
    .optional()
    .describe(
      "AWS region for pricing lookup (e.g. 'us-east-1'). Defaults to us-east-1.",
    ),
};

export function registerEstimateCost(server: McpServer): void {
  server.tool(
    "estimate_cost",
    "Estimate the monthly cost of an AWS resource without creating a full plan. Fast pricing lookup only — no provisioning or state changes.",
    estimateCostParams,
    async ({ description, resourceType, desiredState, region }) => {
      // 1. Determine the resource type
      const resolvedType = resourceType ?? classifyResourceType(description);

      // 2. Handle unknown resource types (AC #5)
      if (!resolvedType) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                resourceType: "unknown",
                estimatedMonthlyCost: "N/A",
                description,
                region: region ?? DEFAULT_AWS_REGION,
                note: "Resource type not recognized from description. Provide an explicit resourceType parameter for accurate estimates.",
              }),
            },
          ],
        };
      }

      // 3. Estimate cost using the pricing registry
      const estimate = estimateCostForResource(
        resolvedType,
        desiredState as Record<string, unknown> | undefined,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...estimate,
              description,
              region: region ?? DEFAULT_AWS_REGION,
              note: "This is a baseline estimate. Use plan_resource for more accurate cost quotes that consider full resource configuration.",
            }),
          },
        ],
      };
    },
  );
}
