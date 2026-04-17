import { z } from "zod";
import {
  ExecutionStatus,
  SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES,
  defaultPatternRegistry,
  sanitizeUserIntent,
} from "../../index.js";
import type { LlmPort } from "../../index.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";

/**
 * Human-readable hint shown when an unsupported resource type is requested.
 * Inlined into the node (Story 50-4 Wave 5 Pass D) so core has no
 * dependency on the CLI's long-form help text. The CLI's
 * `config/constants/help.ts` keeps the richer version (with literal
 * `assignee` invocation examples) for user-facing `--help` output; the
 * node-returned message is used in graph-state.errorMessage only.
 */
const SUPPORTED_TYPES_HINT = `What you can create (${SUPPORTED_TYPES.length} resource types):

  Compute       EC2 instance, Lambda function, ECS cluster
  Storage       S3 bucket
  Databases     RDS (PostgreSQL/MySQL/MariaDB/Aurora), DynamoDB table
  Networking    VPC, Subnet, Security Group, Internet Gateway,
                NAT Gateway, Route Table, Route, Load Balancer
  API           API Gateway v2 (HTTP/WebSocket)
  Messaging     SQS queue, SNS topic
  Security      IAM role, Secrets Manager secret, SSM parameter
  Containers    ECR repository
  Observability CloudWatch alarm, CloudWatch Logs group

Examples:
  assignee plan "Create an S3 bucket for my static site"
  assignee plan "Create an EC2 t3.micro with SSH"
  assignee plan "Create a PostgreSQL database for production"`;

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
