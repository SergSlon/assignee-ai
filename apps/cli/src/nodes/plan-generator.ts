/**
 * plan_generator node — calls Bedrock to produce a CloudFormation desiredState
 * that satisfies the user's intent and conforms to the fetched schema.
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 */

import { generateText } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { ExecutionStatus } from "@assignee/core";
import {
  BEDROCK_MODEL_ID,
  AWS_REGION,
  SCHEMA_EXCERPT_MAX_CHARS,
} from "../config/constants.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const bedrock = createAmazonBedrock({ region: AWS_REGION });

export async function planGeneratorNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  if (!state.resourceSchema) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage:
        "Cannot generate plan: resource schema is missing. Hint: check cfn-mcp-server connectivity.",
    };
  }

  const startedAt = Date.now();
  const schemaProperties =
    (state.resourceSchema["properties"] as
      | Record<string, unknown>
      | undefined) ?? {};
  const schemaKeys = Object.keys(schemaProperties);
  const requiredKeys: string[] =
    (state.resourceSchema["required"] as string[] | undefined) ?? [];

  try {
    if (!process.env["BEDROCK_GUARDRAIL_ID"]) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.GUARDRAIL_DISABLED,
        message: "BEDROCK_GUARDRAIL_ID not set — guardrail disabled for POC",
      });
    }

    const guardrailOpts = process.env["BEDROCK_GUARDRAIL_ID"]
      ? {
          guardrailIdentifier: process.env["BEDROCK_GUARDRAIL_ID"],
          guardrailVersion: process.env["BEDROCK_GUARDRAIL_VERSION"] ?? "1",
        }
      : {};

    const { text } = await generateText({
      model: bedrock(BEDROCK_MODEL_ID),
      // @ts-expect-error NFR-15: maxTokens may not be typed in this SDK version
      maxTokens: 1024,
      ...guardrailOpts,
      messages: [
        {
          role: "user",
          content: [
            `You are an AWS CloudFormation expert. Generate a valid JSON configuration object for resource type "${state.resourceType}".`,
            `User intent: "${state.userIntent}"`,
            "",
            `Required properties: ${JSON.stringify(requiredKeys)}`,
            `Available properties: ${JSON.stringify(schemaKeys)}`,
            "",
            "RULES:",
            "1. Output ONLY valid JSON — no markdown fences, no explanation",
            "2. Include ONLY properties from the Available properties list",
            "3. Include ALL Required properties",
            "4. For S3 BucketName: use only lowercase letters, digits, hyphens (3–63 chars)",
            "",
            `Schema excerpt:\n${JSON.stringify(state.resourceSchema, null, 2).slice(0, SCHEMA_EXCERPT_MAX_CHARS)}`,
            "",
            "Output the JSON object now:",
          ].join("\n"),
        },
      ],
    });

    let desiredState: Record<string, unknown>;
    try {
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
      desiredState = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          "Plan generator returned invalid JSON. Hint: try rephrasing your intent.",
      };
    }

    // Validate against schema — drop hallucinated fields (Zod.strict equivalent)
    if (schemaKeys.length > 0) {
      const validated: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(desiredState)) {
        if (schemaKeys.includes(key)) {
          validated[key] = val;
        }
        // silently drop fields not in schema
      }
      desiredState = validated;
    }

    const durationMs = Date.now() - startedAt;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      durationMs,
      resourceType: state.resourceType,
    });

    return { desiredState };
  } catch (err: unknown) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Plan generation failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
