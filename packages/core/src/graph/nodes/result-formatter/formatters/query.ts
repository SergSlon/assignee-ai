/**
 * Query-result formatter — renders the output of a read-only query intent.
 *
 * Called by the result-formatter registry when `executionStatus=QUERY_INTENT`.
 * Renders the list of matching managed resources using the same display
 * primitives as `assignee list`, plus a completion footer confirming that
 * zero AWS writes were performed.
 *
 * HIGH 4 fix: honours `state.outputFormat === "json"` — emits a structured
 * JSON envelope `{ status: "QUERY_INTENT", queryResult }` to stdout when
 * JSON mode is active. Mirrors the pattern used by formatPlanResult (plan.ts).
 *
 * Story: feature-query-intent-classifier
 */

import * as clack from "@clack/prompts";
import type { AgentState } from "@/graph/graph-state.js";
import {
  renderResourceTable,
  renderEmptyList,
} from "@/utils/display-output/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";

/**
 * Render the query result to stdout.
 *
 * Four branches:
 * 1. JSON mode → emit structured envelope, no clack rendering.
 * 2. `state.queryResult` present + resources found → table render.
 * 3. `state.queryResult` present + empty → type-specific "not found" message.
 * 4. `state.queryResult` absent + errorMessage present (no-fetcher path) →
 *    helpful one-paragraph message, NOT the 38-type wall.
 */
export async function formatQueryResult(
  state: AgentState,
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESULT_FORMATTED,
    extras: { executionStatus: state.executionStatus, kind: "query" },
  });

  // HIGH 4: JSON output mode — emit structured envelope to stdout.
  // Matches the envelope shape used by formatPlanResult (plan.ts:284).
  if (state.outputFormat === "json") {
    process.stdout.write(
      JSON.stringify(
        {
          status: "QUERY_INTENT",
          queryResult: state.queryResult ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    return {};
  }

  const queryResult = state.queryResult;

  if (!queryResult) {
    // query_handler set an errorMessage (e.g. no-fetcher path or AWS error)
    // but didn't populate queryResult. Render a helpful paragraph.
    const msg =
      state.errorMessage ??
      "I couldn't determine what you were looking for. " +
        "Try `assignee list` to see all managed resources, " +
        "or `assignee describe <arn>` to inspect a specific resource.";

    clack.log.info(msg);
    clack.log.info("Query completed. Zero AWS writes performed.");
    return {};
  }

  if (queryResult.isEmpty || queryResult.resources.length === 0) {
    // Empty result for the queried type — type-specific message, not the 38-type wall.
    const typeLabel = queryResult.resourceType
      ? ` managed ${queryResult.resourceType} resource`
      : " managed resource";
    const emptyMsg = queryResult.resourceType
      ? `No${typeLabel}s found in your account. ` +
        `Run \`assignee list\` to see all managed resources, ` +
        `or \`assignee apply\` to create one.`
      : "No managed resources found in your account. " +
        "Run `assignee list` to verify, or `assignee apply` to create resources.";

    renderEmptyList();
    clack.log.info(emptyMsg);
    clack.log.info("Query completed. Zero AWS writes performed.");
    return {};
  }

  // Resources found — render the same table as `assignee list`.
  renderResourceTable(queryResult.resources);

  clack.log.success(
    `Query completed — found ${queryResult.resources.length} managed resource${queryResult.resources.length === 1 ? "" : "s"}. ` +
      "Zero AWS writes performed.",
  );

  return {};
}
