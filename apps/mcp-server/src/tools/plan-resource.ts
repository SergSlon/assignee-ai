/**
 * plan_resource MCP tool — generates an infrastructure plan from natural language.
 * Invokes the LangGraph agent graph in PLAN mode and returns structured plan JSON.
 *
 * @see Epic 20, Story 20.2
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ExecutionMode,
  ExecutionStatus,
  BPEnforcementLevel,
  StateField,
  renderSupportedTypesHint,
} from "@assignee/core";

/** Error prefix used when plan generation fails. */
const PLAN_GENERATION_FAILED = "Plan generation failed" as const;
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

        // Task 3.2: If env is provided, prepend to description for intent parser
        const enrichedDescription = env
          ? `[env:${env}] ${description}`
          : description;

        // Task 1.2: Invoke the LangGraph graph in PLAN mode
        // Task 3.1: Pass region through graph state, not process.env (concurrent-safe)
        const finalState = await ctx.graph.invoke(
          {
            userIntent: enrichedDescription,
            runId,
            executionMode: ExecutionMode.PLAN,
            startedAt: Date.now(),
            noWizard: true, // MCP server never prompts interactively
            bpEnforcementLevel: BPEnforcementLevel.ENFORCE, // Always enforce BPs in MCP
            ...(region ? { awsRegion: region } : {}),
          },
          { configurable: { thread_id: runId } },
        );

        // Task 1.3: Check for execution errors
        if (
          finalState[StateField.EXECUTION_STATUS] === ExecutionStatus.FAILED ||
          finalState[StateField.EXECUTION_STATUS] ===
            ExecutionStatus.UNSUPPORTED_RESOURCE
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message:
                    (finalState[StateField.ERROR_MESSAGE] as string) ??
                    PLAN_GENERATION_FAILED,
                  status: finalState[StateField.EXECUTION_STATUS],
                  ...(finalState[StateField.EXECUTION_STATUS] ===
                  ExecutionStatus.UNSUPPORTED_RESOURCE
                    ? {
                        hint: renderSupportedTypesHint("mcp"),
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
          resourceType: finalState[StateField.RESOURCE_TYPE] as
            | string
            | undefined,
          desiredState: finalState[StateField.DESIRED_STATE] as
            | Record<string, unknown>
            | undefined,
          estimatedMonthlyCost: finalState[
            StateField.ESTIMATED_MONTHLY_COST
          ] as string | undefined,
          preflightPassed: finalState[StateField.PREFLIGHT_PASSED] as
            | boolean
            | undefined,
          elicitedOptions: finalState[StateField.ELICITED_OPTIONS] as
            | Record<string, unknown>
            | undefined,
          resourcePattern: finalState[StateField.RESOURCE_PATTERN] as
            | { patternId?: string }
            | undefined,
          resourceQueue: finalState[StateField.RESOURCE_QUEUE] as
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
                resourceType: finalState[StateField.RESOURCE_TYPE],
                desiredState: finalState[StateField.DESIRED_STATE],
                estimatedMonthlyCost:
                  finalState[StateField.ESTIMATED_MONTHLY_COST],
                bpFindings:
                  (finalState[StateField.BP_FINDINGS] as unknown[]) ?? [],
                freeTierNote: finalState[StateField.FREE_TIER_NOTE],
                adviceHints:
                  (finalState[StateField.ADVICE_HINTS] as string[]) ?? [],
                checkpointPath,
                runId,
              }),
            },
          ],
        };
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
