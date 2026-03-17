import { generateText, Output } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { z } from "zod";
import {
  SUPPORTED_TYPES,
  SUPPORTED_TYPES_HINT,
  BEDROCK_MODEL_ID,
  AWS_REGION,
} from "../config/constants.js";
import { ExecutionStatus } from "@assignee/core";
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
  const { output } = await generateText({
    model: bedrock(BEDROCK_MODEL_ID),
    output: Output.object({ schema: intentParserSchema }),
    // @ts-expect-error NFR-15: maxTokens might not be defined in this version's types
    maxTokens: 1024,
    messages: [
      {
        role: "user",
        content: `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.\n\nRequest: "${state.userIntent}"`,
      },
    ],
  });

  if (output.resourceType === "UNSUPPORTED") {
    return {
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
      errorMessage: `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
    };
  }

  // Type safe cast since zod enum is derived from SUPPORTED_TYPES
  return { resourceType: output.resourceType };
}
