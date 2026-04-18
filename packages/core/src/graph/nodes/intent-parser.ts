import { z } from "zod";
import {
  ExecutionStatus,
  SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES,
  defaultPatternRegistry,
  renderSupportedTypesHint,
  sanitizeUserIntent,
} from "../../index.js";
import type { LlmPort } from "../../index.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

/**
 * Human-readable hint shown when an unsupported resource type is
 * requested. Pulled from the core help-hints single source of truth
 * (Story 54-it1-04) so the node's errorMessage, the CLI's `--help`
 * output, and the MCP plan-resource tool all render from the same
 * registry-derived strings. The `short` style omits the EFS/CFN
 * detail lines to keep the inline graph-state errorMessage compact.
 */
const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("short");

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
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.INTENT_PARSED,
        extras: { resourceType: null, pattern: detectedPattern.patternId },
      });
      return { userIntent: safeIntent, resourcePattern: detectedPattern };
    }

    // Bedrock classification — uses sanitized intent.
    // Wave-4 F5 P2-R2-6: three disambiguation sentences were added so that
    // "Create a standalone X" / "Create an X on its own" always classifies
    // as the bare X type instead of being rerouted through a compound
    // pattern. Needed to unblock three previously-skipped E2E plan tests
    // for bare RDS DBInstance / Events Connection / Events ApiDestination
    // — each is first-class in SUPPORTED_TYPES but the LLM defaulted to
    // compound-style routing without explicit guidance.
    const prompt = `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_TYPES.join(", ")} or UNSUPPORTED.
If the request says "standalone", "bare", "single", "on its own", or "just the X" (or otherwise explicitly asks for one resource in isolation), classify it as that exact type — do NOT reroute to a compound / multi-resource pattern even if the resource is usually deployed alongside others.
Events::Connection and Events::ApiDestination ARE first-class types in this list — classify as those when the intent is to create the Connection or ApiDestination itself, even without an accompanying Rule or EventBus.
RDS::DBInstance is first-class and MUST be classified as AWS::RDS::DBInstance when the request asks for a standalone database, regardless of whether a VPC / subnet group is mentioned.

Request: "${safeIntent}"`;
    const [err, output] = await llmClient.generateStructured(
      prompt,
      intentParserSchema,
      { callsite: "intent_parser", runId: state.runId },
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
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: { resourceType: output.resourceType, pattern: null },
    });
    return { userIntent: safeIntent, resourceType: output.resourceType };
  };
}
