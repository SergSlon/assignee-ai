import { generateText, Output } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { z } from "zod";
import {
  SUPPORTED_TYPES,
  SUPPORTED_TYPES_HINT,
  BEDROCK_MODEL_ID,
  AWS_REGION,
} from "../config/constants.js";
import {
  ExecutionStatus,
  defaultPatternRegistry,
  sanitizeUserIntent,
} from "@assignee/core";
import type { AgentState } from "../services/graph.js";

const bedrock = createAmazonBedrock({ region: AWS_REGION });

const intentParserSchema = z.object({
  resourceType: z.enum([...SUPPORTED_TYPES, "UNSUPPORTED"] as [
    string,
    ...string[],
  ]),
});

export async function intentParserNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  // Sanitize user intent first (NFR-16: Prompt Injection Protection)
  const safeIntent = sanitizeUserIntent(state.userIntent);

  // Pattern detection — zero latency, no Bedrock call when pattern matches
  const detectedPattern = defaultPatternRegistry.detect(safeIntent);
  if (detectedPattern !== null) {
    return { userIntent: safeIntent, resourcePattern: detectedPattern };
  }

  // Existing single-resource Bedrock classification — uses sanitized intent
  const { output } = await generateText({
    model: bedrock(BEDROCK_MODEL_ID),
    output: Output.object({ schema: intentParserSchema }),
    maxOutputTokens: 1024, // TODO(ai-sdk): parameter name may change across SDK versions
    messages: [
      {
        role: "user",
        content: `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.\n\nRequest: "${safeIntent}"`,
      },
    ],
  });

  if (output.resourceType === "UNSUPPORTED") {
    return {
      userIntent: safeIntent,
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
      errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
    };
  }

  // Type safe cast since zod enum is derived from SUPPORTED_TYPES
  return { userIntent: safeIntent, resourceType: output.resourceType };
}
