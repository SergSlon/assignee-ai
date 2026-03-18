import { z } from "zod";
import { SUPPORTED_TYPES, SUPPORTED_TYPES_HINT } from "../config/constants.js";
import {
  ExecutionStatus,
  defaultPatternRegistry,
  sanitizeUserIntent,
} from "@assignee/core";
import type { LlmPort } from "@assignee/core";
import type { AgentState } from "../services/graph.js";

const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
});

/**
 * Factory for the intent_parser LangGraph node.
 * Accepts llmClient via injection — no direct @ai-sdk imports.
 *
 * @see Story 9.5 — LLM client decoupling (M3)
 */
export function createIntentParserNode({ llmClient }: { llmClient: LlmPort }) {
  return async function intentParserNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    // Sanitize user intent first (NFR-16: Prompt Injection Protection)
    const safeIntent = sanitizeUserIntent(state.userIntent);

    // Pattern detection — zero latency, no LLM call when pattern matches
    const detectedPattern = defaultPatternRegistry.detect(safeIntent);
    if (detectedPattern !== null) {
      return { userIntent: safeIntent, resourcePattern: detectedPattern };
    }

    // Bedrock classification — uses sanitized intent
    const prompt = `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.\n\nRequest: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
    );

    if (err) {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Intent parsing failed. Hint: check Bedrock connectivity and AWS credentials. Error: ${err.message}`,
      };
    }

    if (output.resourceType === "UNSUPPORTED") {
      return {
        userIntent: safeIntent,
        executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
        errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
      };
    }

    // Type safe cast since zod enum is derived from SUPPORTED_TYPES
    return { userIntent: safeIntent, resourceType: output.resourceType };
  };
}
