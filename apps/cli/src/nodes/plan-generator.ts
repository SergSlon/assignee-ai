/**
 * plan_generator node — calls Bedrock to produce a CloudFormation desiredState
 * that satisfies the user's intent and conforms to the fetched schema.
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 */

import { generateText } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { ExecutionStatus, RESOURCE_TYPES } from "@assignee/core";
import {
  BEDROCK_MODEL_ID,
  AWS_REGION,
  SCHEMA_EXCERPT_MAX_CHARS,
} from "../config/constants.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

const bedrock = createAmazonBedrock({ region: AWS_REGION });

/** Current Lambda runtimes as of 2025. Used to prevent the LLM from choosing deprecated ones. */
const SUPPORTED_LAMBDA_RUNTIMES = [
  "nodejs22.x",
  "nodejs20.x",
  "python3.13",
  "python3.12",
  "java21",
  "dotnet8",
  "ruby3.3",
  "provided.al2023",
] as const;

/**
 * Returns additional prompt rules for resource types that have known LLM failure modes.
 * Injected into the plan_generator prompt after the standard rules.
 */
function getResourceHints(resourceType: string): string[] {
  if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    return [
      `Lambda Runtime MUST be one of: ${SUPPORTED_LAMBDA_RUNTIMES.join(", ")}. NEVER use deprecated runtimes (python3.8, python3.9, nodejs18.x, nodejs16.x, etc.)`,
      "Lambda Role: if the user did not provide a specific IAM role ARN, OMIT the Role property — do NOT invent placeholder ARNs",
    ];
  }
  return [];
}

/** Recursively removes empty-placeholder values the LLM may insert despite prompt rules. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (typeof v === "number" && v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length === 0) continue;
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

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
  // cfn-mcp-server returns lowercase "properties"; older servers used "Properties"
  const schemaProperties =
    (state.resourceSchema["properties"] as
      | Record<string, unknown>
      | undefined) ??
    (state.resourceSchema["Properties"] as
      | Record<string, unknown>
      | undefined) ??
    {};
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

    const resourceHints = getResourceHints(state.resourceType ?? "");

    const { text } = await generateText({
      model: bedrock(BEDROCK_MODEL_ID),
      maxOutputTokens: 1024, // TODO(ai-sdk): parameter name may change across SDK versions
      ...guardrailOpts,
      messages: [
        {
          role: "user",
          content: [
            `You are an AWS resource configuration expert. Generate the resource properties JSON for a "${state.resourceType}" resource.`,
            `User intent: "${state.userIntent}"`,
            "",
            `Required properties: ${JSON.stringify(requiredKeys)}`,
            `Available properties: ${JSON.stringify(schemaKeys)}`,
            "",
            "RULES:",
            "1. Output ONLY valid JSON — no markdown fences, no explanation",
            "2. Output a FLAT JSON object with ONLY the resource properties directly — do NOT wrap in a CloudFormation Resources block or nest under a logical resource ID",
            "3. Include ONLY properties from the Available properties list",
            "4. Include ALL Required properties with real values",
            "5. Include properties clearly implied by the user's intent (e.g. InstanceType, Engine, FunctionName, Runtime)",
            "6. OMIT any property you don't have a specific value for — do NOT use empty strings, 0, false, or [] as placeholders",
            "7. For S3 BucketName: use only lowercase letters, digits, hyphens (3–63 chars)",
            ...(resourceHints.length > 0
              ? [
                  "",
                  "RESOURCE-SPECIFIC RULES (take precedence over general rules above):",
                  ...resourceHints.map((h, i) => `R${i + 1}. ${h}`),
                ]
              : []),
            "",
            'CORRECT format example: { "BucketName": "my-bucket" }',
            'WRONG format example: { "MyBucket": { "Type": "AWS::S3::Bucket", "Properties": { "BucketName": "my-bucket" } } }',
            "",
            `Schema excerpt:\n${JSON.stringify(state.resourceSchema, null, 2).slice(0, SCHEMA_EXCERPT_MAX_CHARS)}`,
            "",
            "Output the flat properties JSON object now:",
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

    // Safety net: unwrap CloudFormation Resources section format if LLM generated it.
    // Detects: { "LogicalId": { "Type": "AWS::...", "Properties": {...} } }
    const topValues = Object.values(desiredState);
    if (
      topValues.length === 1 &&
      typeof topValues[0] === "object" &&
      topValues[0] !== null
    ) {
      const inner = topValues[0] as Record<string, unknown>;
      if (
        typeof inner["Type"] === "string" &&
        (inner["Type"] as string).startsWith("AWS::") &&
        typeof inner["Properties"] === "object"
      ) {
        desiredState = inner["Properties"] as Record<string, unknown>;
      }
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

    // Remove empty placeholders the LLM may have inserted despite the prompt rules
    desiredState = stripEmpty(desiredState);

    // Merge elicited options — user-confirmed values override LLM-generated values.
    // elicitedOptions fields come from the schema so no hallucination risk.
    if (
      state.elicitedOptions &&
      Object.keys(state.elicitedOptions).length > 0
    ) {
      desiredState = { ...desiredState, ...state.elicitedOptions };
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
