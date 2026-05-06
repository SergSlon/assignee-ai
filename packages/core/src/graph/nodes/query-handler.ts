/**
 * query_handler — handles read-only query intents.
 *
 * Dispatched when the intent-parser classifies the user's input as
 * `kind=query` (e.g. "what's my CloudFront site URL?", "list my S3 buckets").
 * Resolves the question against managed resources via an injected fetcher
 * port and populates `state.queryResult` for the result-formatter to render.
 *
 * Design principles:
 * - Core is SDK-agnostic; the actual AWS fetcher is injected at graph-
 *   construction time via the `resourceFetcher` option.  CLI injects the
 *   RGTA-backed implementation; MCP injects its own; tests pass a mock.
 * - Zero AWS writes.  This node NEVER calls CloudControl or any mutating API.
 * - Bypasses schema-fetch / wizard / plan-generator / preflight / HITL gate.
 * - On failure (fetcher throws, empty result for a specific type), sets a
 *   helpful `errorMessage` pointing the user to `assignee list` — never
 *   the 38-type wall.
 *
 * Story: feature-query-intent-classifier
 */

import type { ManagedResource } from "../../list-resources/types.js";
import { ExecutionStatus } from "../../schema/graph-state.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import { appendAuditRecord } from "../../audit/audit-log.js";
import type { AgentState, QueryResult } from "../graph-state.js";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Injected port: a function that returns managed resources, optionally
 * filtered to a specific CloudFormation resource type.
 *
 * The CLI wires `apps/cli/src/services/list-resources.ts`'s
 * `fetchManagedResources` here; the MCP server wires its own RGTA wrapper.
 */
export type ManagedResourceFetcher = (
  resourceTypeFilter?: string,
) => Promise<ManagedResource[]>;

// Re-export QueryResult for consumers that import it from query-handler.
export type { QueryResult } from "../graph-state.js";

// ─── Type guard ──────────────────────────────────────────────────────────────

/**
 * MED 1: Type guard for AgentState["intentKind"] — replaces unsafe `as` casts.
 * Validates that a value is one of the four intent kinds defined on AgentState.
 */
export function isIntentKind(v: unknown): v is AgentState["intentKind"] {
  return v === "create" || v === "query" || v === "destroy" || v === "update";
}

// ─── Keyword-to-CFN-type mapping ─────────────────────────────────────────────

/**
 * Maps lowercase query keywords to canonical CFN resource types.
 *
 * HIGH 2 fix: patterns are:
 * - Anchored with \b...\b to prevent over-matching partial tokens.
 * - Ordered longest/most-specific first so "rds instance" hits RDS not EC2.
 * - Bare-noun matches replaced with full noun phrases (e.g. \bec2 instance\b
 *   instead of \binstance\b alone) to prevent false positives.
 *
 * Intentionally conservative: only map keywords that unambiguously identify
 * a single resource type. Ambiguous terms fall through to the unfiltered
 * list path.
 *
 * Acceptance criterion 1: "CloudFront" → AWS::CloudFront::Distribution.
 * Acceptance criterion 2: "S3 buckets" → AWS::S3::Bucket.
 */
const KEYWORD_TO_CFN_TYPE: Array<[RegExp, string]> = [
  // CloudFront — "distribution" alone is specific enough (CloudFront is the
  // only AWS service that uses this noun in this context).
  [
    /\bcloudfront\b|\bdistribution\b|\bcloudfront distribution\b/i,
    "AWS::CloudFront::Distribution",
  ],
  // RDS BEFORE EC2: "rds instance" must match RDS, not EC2.
  [/\brds\b|\brds instance\b|\bdb instance\b/i, "AWS::RDS::DBInstance"],
  // DynamoDB — unambiguous.
  [/\bdynamodb\b|\bdynamo\b/i, "AWS::DynamoDB::Table"],
  // EFS — "efs file system" before bare "file system" (which is ambiguous).
  [/\befs\b|\befs file system\b/i, "AWS::EFS::FileSystem"],
  // Security group — multi-word; must come before "ec2" to avoid prefix match.
  [/\bsecurity group\b|\bsecurity groups\b/i, "AWS::EC2::SecurityGroup"],
  // IAM role — "iam role" specifically; "role" alone too ambiguous.
  [/\biam role\b|\biam roles\b|\biam::role\b/i, "AWS::IAM::Role"],
  // EventBridge — specific service name or compound phrase.
  [/\beventbridge\b|\bevent bus\b|\bevents rule\b/i, "AWS::Events::Rule"],
  // ECR — specific; "repository" alone too ambiguous.
  [/\becr\b|\bcontainer registry\b/i, "AWS::ECR::Repository"],
  // ECS — "ecs cluster" or bare "ecs"; bare "cluster" too ambiguous (RDS clusters etc.).
  [/\becs\b|\becs cluster\b/i, "AWS::ECS::Cluster"],
  // KMS — "kms key" specifically; bare "key" matches "API key" / "SSH key" etc.
  [/\bkms\b|\bkms key\b/i, "AWS::KMS::Key"],
  // SNS — "sns topic" specifically; bare "topic" too generic.
  [/\bsns\b|\bsns topic\b|\bsns topics\b/i, "AWS::SNS::Topic"],
  // SQS — "sqs queue" specifically; bare "queue" too generic.
  [/\bsqs\b|\bsqs queue\b|\bsqs queues\b/i, "AWS::SQS::Queue"],
  // VPC — specific enough on its own.
  [/\bvpc\b|\bvpcs\b/i, "AWS::EC2::VPC"],
  // Lambda — "lambda function" specifically; bare "function" too generic.
  [
    /\blambda function\b|\blambda functions\b|\blambda\b/i,
    "AWS::Lambda::Function",
  ],
  // EC2 — "ec2 instance" specifically; bare "instance" is ambiguous (RDS, ECS, etc.).
  [/\bec2\b|\bec2 instance\b|\bec2 instances\b/i, "AWS::EC2::Instance"],
  // S3 — "\bs3\b" anchored to avoid false positives; "s3 bucket" as phrase.
  [/\bs3\b|\bs3 bucket\b|\bs3 buckets\b/i, "AWS::S3::Bucket"],
];

/**
 * Infer the CFN resource type from a natural-language query string.
 * Returns `undefined` when no unambiguous mapping is found.
 */
export function inferResourceTypeFromQuery(query: string): string | undefined {
  for (const [pattern, cfnType] of KEYWORD_TO_CFN_TYPE) {
    if (pattern.test(query)) return cfnType;
  }
  return undefined;
}

// ─── Node factory ─────────────────────────────────────────────────────────────

/**
 * Factory for the query_handler LangGraph node.
 *
 * @param resourceFetcher - Injected port for fetching managed resources.
 *   Defaults to a no-op that returns an informative error when not wired
 *   (e.g. bare unit test context without a real fetcher).
 */
export function createQueryHandlerNode(
  resourceFetcher?: ManagedResourceFetcher,
) {
  return async function queryHandlerNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    const intent = state.userIntent ?? "";
    const naturalQuestion = intent.trim() || "your query";

    // HIGH 1 fix: use QUERY_RESOLVED action (not INTENT_PARSED — that fires
    // in intent-parser); field is resourceType not intentKind.
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.QUERY_RESOLVED,
      extras: {
        intentKind: "query",
        resourceType: state.resourceType ?? null,
      },
    });

    // If no fetcher was injected, surface a helpful message rather than crashing.
    if (!resourceFetcher) {
      return {
        executionStatus: ExecutionStatus.QUERY_INTENT,
        errorMessage:
          "Query routing is not available in this context. " +
          "Use `assignee list` to see all managed resources, " +
          "or `assignee describe <arn>` to inspect a specific resource.",
        queryResult: {
          resources: [],
          naturalQuestion,
          isEmpty: true,
        },
      };
    }

    // Use the resourceType that the intent-parser may have identified, OR
    // fall back to keyword-extraction from the raw intent.
    const resolvedType =
      state.resourceType || inferResourceTypeFromQuery(intent) || undefined;

    try {
      const resources = await resourceFetcher(resolvedType);

      const result: QueryResult = {
        resourceType: resolvedType,
        resources,
        naturalQuestion,
        isEmpty: resources.length === 0,
      };

      // MED 2: Audit log for query executions (Story §Open Questions #3).
      // Non-fatal: audit write failure must not break the query result path.
      try {
        await appendAuditRecord({
          action: "query_executed",
          intent: naturalQuestion,
          resourceType: resolvedType ?? null,
          resultCount: resources.length,
        });
      } catch {
        // Swallow silently — audit failure should not surface to the user.
      }

      return {
        executionStatus: ExecutionStatus.QUERY_INTENT,
        queryResult: result,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
        extras: { error: errMsg, phase: "query_handler" },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          `Could not fetch managed resources: ${errMsg}. ` +
          "Check that AWS credentials are configured. " +
          "Run `assignee list` directly to verify connectivity.",
      };
    }
  };
}
