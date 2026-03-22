/**
 * plan_resource MCP tool — generates an infrastructure plan from natural language.
 * Invokes the LangGraph agent graph in PLAN mode and returns structured plan JSON.
 *
 * @see Epic 20, Story 20.2
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { GraphContext } from "../services/graph-init.js";
import {
  serializeCheckpoint,
  saveCheckpoint,
  MCP_CHECKPOINT_DIR,
} from "../services/checkpoint.js";

export const planResourceParams = {
  description: z
    .string()
    .describe(
      "Natural language description of the infrastructure to provision (e.g. 'Create an S3 bucket for static website hosting')",
    ),
  region: z
    .string()
    .optional()
    .describe(
      "AWS region to deploy the resource in (e.g. 'us-east-1'). Defaults to configured region.",
    ),
  env: z
    .string()
    .optional()
    .describe(
      "Environment tag (e.g. 'dev', 'staging', 'prod'). Applied as a tag to the resource.",
    ),
};

export function registerPlanResource(
  server: McpServer,
  ctx?: GraphContext,
): void {
  server.tool(
    "plan_resource",
    "Generate an infrastructure plan from a natural language description. Returns a desired-state JSON and estimated monthly cost.",
    planResourceParams,
    async ({ description, region, env }) => {
      // Guard: ctx is required for real invocations (may be absent in stub/registration tests)
      if (!ctx) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message:
                  "Graph context not initialized. The MCP server may still be starting up.",
                status: "NOT_READY",
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const runId = crypto.randomUUID();

        // Task 3.1: If region is provided, set AWS_REGION for graph invocation
        const previousRegion = process.env["AWS_REGION"];
        if (region) {
          process.env["AWS_REGION"] = region;
        }

        // Task 3.2: If env is provided, prepend to description for intent parser
        const enrichedDescription = env
          ? `[env:${env}] ${description}`
          : description;

        try {
          // Task 1.2: Invoke the LangGraph graph in PLAN mode
          const finalState = await ctx.graph.invoke(
            {
              userIntent: enrichedDescription,
              runId,
              executionMode: ExecutionMode.PLAN,
              startedAt: Date.now(),
              noWizard: true, // MCP server never prompts interactively
            },
            { configurable: { thread_id: runId } },
          );

          // Task 1.3: Check for execution errors
          if (
            finalState["executionStatus"] === ExecutionStatus.FAILED ||
            finalState["executionStatus"] ===
              ExecutionStatus.UNSUPPORTED_RESOURCE
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: true,
                    message:
                      (finalState["errorMessage"] as string) ??
                      "Plan generation failed",
                    status: finalState["executionStatus"],
                    ...(finalState["executionStatus"] ===
                    ExecutionStatus.UNSUPPORTED_RESOURCE
                      ? {
                          hint: "Supported types: S3, Lambda, DynamoDB, SQS, SNS, EC2, RDS, IAM Role, SSM Parameter, CloudWatch Logs, EventBridge Rule.",
                        }
                      : {}),
                  }),
                },
              ],
              isError: true,
            };
          }

          // Task 1.4: Serialize checkpoint and return structured plan
          const checkpoint = serializeCheckpoint({
            runId,
            userIntent: enrichedDescription,
            resourceType: finalState["resourceType"] as string | undefined,
            desiredState: finalState["desiredState"] as
              | Record<string, unknown>
              | undefined,
            estimatedMonthlyCost: finalState["estimatedMonthlyCost"] as
              | string
              | undefined,
            preflightPassed: finalState["preflightPassed"] as
              | boolean
              | undefined,
            elicitedOptions: finalState["elicitedOptions"] as
              | Record<string, unknown>
              | undefined,
            resourcePattern: finalState["resourcePattern"] as
              | { patternId?: string }
              | undefined,
            resourceQueue: finalState["resourceQueue"] as
              | Array<{
                  resourceId: string;
                  resourceType: string;
                  displayName: string;
                }>
              | undefined,
          });

          const checkpointPath = await saveCheckpoint(
            checkpoint,
            MCP_CHECKPOINT_DIR,
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  resourceType: finalState["resourceType"],
                  desiredState: finalState["desiredState"],
                  estimatedMonthlyCost: finalState["estimatedMonthlyCost"],
                  bpFindings: (finalState["bpFindings"] as unknown[]) ?? [],
                  freeTierNote: finalState["freeTierNote"],
                  checkpointPath,
                  runId,
                }),
              },
            ],
          };
        } finally {
          // Restore region env var
          if (region) {
            if (previousRegion !== undefined) {
              process.env["AWS_REGION"] = previousRegion;
            } else {
              delete process.env["AWS_REGION"];
            }
          }
        }
      } catch (err) {
        // Catch unexpected errors and return as structured MCP error
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Unexpected error during plan generation: ${message}`,
                status: "INTERNAL_ERROR",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
