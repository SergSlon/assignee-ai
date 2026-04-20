/**
 * plan_resource MCP tool — generates an infrastructure plan from natural language.
 * Invokes the LangGraph agent graph in PLAN mode and returns structured plan JSON.
 *
 * SOLID refactor (Story 54-it1-07): this entrypoint is a thin MCP tool
 * handler that composes sub-modules under `./plan-resource/`:
 *   - error-envelope.ts — MCP response shape (success/error)
 *   - handler-steps.ts  — phase helpers (ctx guard / build input /
 *                         status branch / checkpoint+respond /
 *                         unexpected-error envelope) so the handler
 *                         body stays a flat sequence of early-return
 *                         steps using the shared `StepResult<T>`.
 *
 * @see Epic 20 Story 20.2 (original tool), Epic 54 Story 54-it1-07 (refactor)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraphContext } from "../services/graph-init.js";
import {
  buildInitialGraphState,
  buildUnexpectedErrorResponse,
  checkExecutionStatus,
  enrichDescriptionWithEnv,
  guardContext,
  persistCheckpointAndRespond,
} from "./plan-resource/handler-steps.js";

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
      const guarded = guardContext(ctx);
      if (guarded.kind === "done") return guarded.response;
      const graphCtx = guarded.context;

      try {
        const runId = crypto.randomUUID();
        const enrichedDescription = enrichDescriptionWithEnv(description, env);
        const initialState = buildInitialGraphState(
          enrichedDescription,
          runId,
          region,
        );

        // LangGraph's default recursionLimit is 25 super-steps. Compound
        // patterns iterate plan_generator once per resource (4 for
        // static-website, 22 for three-tier-web, 8 for serverless-api,
        // etc.), plus the per-resource sub-nodes (advice_generator,
        // bp_evaluator, preflight_guard, …). A 4-resource compound
        // easily exceeds 25 super-steps and gets cut off mid-plan with
        // "Recursion limit of 25 reached without hitting a stop
        // condition". Mirror apply_plan's 500-step budget so every
        // first-class compound comfortably fits. See Epic 88-it3.
        const finalState = await graphCtx.graph.invoke(initialState, {
          configurable: { thread_id: runId },
          recursionLimit: 500,
        });

        const statusCheck = checkExecutionStatus(finalState);
        if (statusCheck.kind === "done") return statusCheck.response;

        return await persistCheckpointAndRespond(
          finalState,
          runId,
          enrichedDescription,
        );
      } catch (err) {
        return buildUnexpectedErrorResponse(err);
      }
    },
  );
}
