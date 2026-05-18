/**
 * `assignee admin status` command — shows a summary of managed infrastructure.
 *
 * Queries AWS for resources tagged with `managed-by=assignee-ai` and
 * aggregates them by type and region with cost totals. Supports `--json`
 * for machine-readable output and `--region` to filter by AWS region.
 *
 * Also supports `--bp-coverage` for BP coverage dashboard.
 *
 * This is a direct SDK command (no LangGraph graph), following the same
 * pattern as `assignee admin list`.
 *
 * Epic 92 uncluster e92.u.a (A-12, D-08, D-36):
 *   - [runId] positional: accepted now but `status` is a fleet-level
 *     summary that cannot filter by run id. When the caller passes a
 *     runId we emit a `[WARN]` structured log event pointing them at
 *     `assignee admin list --json` (the per-run query surface) and continue
 *     to render the default summary so the command is still useful.
 *   - Structured log envelope: `STATUS_STARTED` at entry, `STATUS_COMPLETE`
 *     at success / error. Matches the plan / optimize envelope so
 *     `--verbose status 2>stderr.log` actually writes JSON events. We do
 *     NOT pull status through the full `runCommand` harness because
 *     status is a direct-SDK command — forcing the LLM client / graph
 *     build just for a summary would introduce a Bedrock-availability
 *     regression. The observable deliverable for D-36 is the log events,
 *     which are emitted directly here.
 *
 * @see Story 19.6, Story 30.7, Epic 92 e92.u.a
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { AssigneeError } from "@assignee/core";
import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderStatusSummary,
  renderEmptyStatus,
  renderError,
} from "../utils/display.js";
import { buildStatusData } from "../services/status-aggregator.js";
import { queryCostAnomalies, type CostAnomaly } from "../services/billing.js";
import { getBillingMcpToolsAsync } from "../services/mcp-client.js";
import {
  computeBPCoverage,
  renderBPCoverage,
  renderBPCoverageGaps,
  filterActionableGaps,
} from "./status-bp-coverage.js";
import { getBpDir } from "./status-factory.js";
import {
  resolveResourceTypeFilter,
  INVALID_RESOURCE_TYPE_CODE,
} from "./resource-type-filter.js";
import { log, LOG_ACTIONS, LogLevel } from "../utils/logger.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { resolveJsonMode } from "./output-format.js";
import { ProcessExitCode } from "../constants/errors.js";

export const statusCommand = new Command(CommandName.STATUS)
  .description(CommandDescription.STATUS)
  // Epic 92 e92.u.a (A-12, D-08): accept an optional [runId] so passing
  // one no longer silently disappears. It's informational — status is
  // fleet-level and doesn't support per-run filtering — but the help
  // text now documents the arg and the WARN event tells the user where
  // to go (`list --json`) for per-run queries.
  .argument(
    "[runId]",
    "Optional run id. `status` is a fleet-level summary and cannot filter by run — when you pass one we emit a warning and point you at `assignee admin list --json` for the per-run query path.",
  )
  // Epic 98 e98.W5.N3 (B-07 / D-16): uniform `--json` + `-o, --output
  // <format>` across every command.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--json", "Shorthand for --output json")
  .option("--region <region>", "Filter to a specific AWS region")
  .option(
    "--resource-type <type>",
    "Filter to one CFN resource type (e.g. AWS::S3::Bucket or shorthand S3, Lambda)",
  )
  .option("--bp-coverage", "Show BP rule coverage dashboard")
  .option(
    "--gaps-only",
    "Only meaningful with --bp-coverage. Prints just the list of resource types with zero BP rules and exits non-zero if any gaps are found (CI-friendly). Structural types (RouteTable, VPCGatewayAttachment, etc.) are excluded by default — override with --include-structural-gaps.",
  )
  .option(
    "--include-structural-gaps",
    "Only meaningful with --bp-coverage --gaps-only. Includes structural/cross-reference types (RouteTable, VPCGatewayAttachment, SubnetRouteTableAssociation, EFS::MountTarget) in the gap list. Default is to exclude them because their BP content lives on child resources by design.",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee admin status
        Summary of managed resources and recent runs
  $ assignee admin status --json
        Machine-readable status payload
  $ assignee admin status --resource-type S3
        Summary scoped to S3 buckets only (shorthand or full CFN form)
  $ assignee admin status --bp-coverage
        Best-practice rule coverage dashboard
  $ assignee admin status --bp-coverage --gaps-only
        CI mode: exit non-zero if any resource type has zero BP rules
  $ assignee admin status <runId>
        status is a fleet-level summary — the positional runId is NOT
        used to filter; we emit a warning and still render the summary.
        Use \`assignee admin list --json\` to query a specific run's resources.

status is read-only. No --yes required.
`,
  )
  .action(
    async (
      runId: string | undefined,
      opts: {
        json?: boolean;
        output?: string;
        region?: string;
        resourceType?: string;
        bpCoverage?: boolean;
        gapsOnly?: boolean;
        includeStructuralGaps?: boolean;
      },
    ) => {
      // Epic 98 e98.W5.N3: normalise `--json` / `--output json` and
      // install the stderr filter under JSON mode. opts.json is
      // kept in sync so the pre-existing branches that still read
      // `opts.json` (inside `runStatusBody`) remain correct.
      const jsonMode = resolveJsonMode(opts);
      opts.json = jsonMode || opts.json;
      const stderrFilter = installJsonStderrFilter(jsonMode);
      try {
        // Per-invocation correlation id. Used to tag the STATUS_STARTED /
        // STATUS_COMPLETE events so a single run can be grep'd end-to-end
        // out of `~/.assignee/logs/cli-YYYY-MM-DD.jsonl`.
        const invocationId = crypto.randomUUID();
        const startTs = Date.now();

        log({
          ts: new Date().toISOString(),
          runId: invocationId,
          level: LogLevel.INFO,
          action: LOG_ACTIONS.STATUS_STARTED,
          extras: {
            intent: "status",
            ...(runId !== undefined ? { suppliedRunId: runId } : {}),
            ...(opts.bpCoverage === true ? { mode: "bp-coverage" } : {}),
            ...(opts.json === true ? { json: true } : {}),
          },
        });

        // A-12: warn the caller that the positional runId doesn't gate
        // the summary. We still execute the default flow so the user
        // isn't punished — they learn about the real query surface
        // (`list --json`) without losing the output they wanted.
        if (runId !== undefined && runId.length > 0) {
          log({
            ts: new Date().toISOString(),
            runId: invocationId,
            level: LogLevel.WARN,
            action: LOG_ACTIONS.STATUS_STARTED,
            extras: {
              warning: "runId-positional-ignored",
              suppliedRunId: runId,
              hint: "`assignee admin status` is a fleet-level summary. Use `assignee admin list --json` (optionally filtered by --resource-type / --region) to query a specific run's resources.",
            },
          });
          // In non-JSON mode also surface the warning on stderr so a
          // user who didn't pass --verbose still learns why their
          // positional is not being honoured. JSON mode keeps stderr
          // minimal so scripted consumers don't get surprise bytes.
          if (opts.json !== true) {
            process.stderr.write(
              `warning: \`status\` ignores the runId positional ("${runId}"). ` +
                "Use `assignee admin list --json` for per-run queries; continuing with fleet-level summary.\n",
            );
          }
        }

        try {
          await runStatusBody(opts);
          log({
            ts: new Date().toISOString(),
            runId: invocationId,
            level: LogLevel.INFO,
            action: LOG_ACTIONS.STATUS_COMPLETE,
            durationMs: Date.now() - startTs,
            result: "ok",
          });
        } catch (err) {
          log({
            ts: new Date().toISOString(),
            runId: invocationId,
            level: LogLevel.ERROR,
            action: LOG_ACTIONS.STATUS_COMPLETE,
            durationMs: Date.now() - startTs,
            result: "error",
            extras: {
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          });
          throw err;
        }
      } finally {
        stderrFilter.restore();
      }
    },
  );

/**
 * The pre-Epic-92-e92.u.a status body. Split out from the action
 * callback so the structured-log envelope wraps it cleanly without
 * reshuffling the nested try/catch flow below.
 */
async function runStatusBody(opts: {
  json?: boolean;
  output?: string;
  region?: string;
  resourceType?: string;
  bpCoverage?: boolean;
  gapsOnly?: boolean;
  includeStructuralGaps?: boolean;
}): Promise<void> {
  // BP Coverage mode (Story 30.7)
  if (opts.bpCoverage) {
    try {
      // Resolve the best-practices package directory via factory
      const bpDir = getBpDir();

      const data = computeBPCoverage(bpDir);

      // --gaps-only: CI-friendly filtered view. JSON mode returns
      // just the gaps array so `jq length` gives the gap count;
      // text mode prints the short list and exits 1 if non-empty.
      // By default the filter drops structural/cross-reference
      // types whose BP content lives on child resources —
      // opts.includeStructuralGaps restores the raw list for
      // users who explicitly want to audit those too.
      if (opts.gapsOnly) {
        const reportedGaps = opts.includeStructuralGaps
          ? data.gaps
          : filterActionableGaps(data.gaps);
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, gaps: reportedGaps }, null, 2) + "\n",
          );
        } else {
          renderBPCoverageGaps(reportedGaps);
        }
        if (reportedGaps.length > 0) {
          process.exitCode = ProcessExitCode.GENERIC_ERROR;
        }
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, ...data }, null, 2) + "\n",
        );
        return;
      }

      renderBPCoverage(data);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      renderError(
        "Failed to compute BP coverage.",
        "Ensure packages/best-practices/ directory is accessible.",
        { why: err.message },
      );
    }
    return;
  }

  // Resolve + validate the --resource-type filter BEFORE hitting
  // AWS. Parity with MCP `list_managed_resources` — same CFN-form
  // filter gets forwarded to core.
  let resolvedResourceType: string | undefined;
  if (opts.resourceType !== undefined) {
    try {
      resolvedResourceType = resolveResourceTypeFilter(opts.resourceType);
    } catch (err) {
      if (
        err instanceof AssigneeError &&
        err.code === INVALID_RESOURCE_TYPE_CODE
      ) {
        renderError(
          `Unknown --resource-type "${opts.resourceType}".`,
          "Pass a supported CFN type (e.g. AWS::S3::Bucket) or a unique shorthand (e.g. S3, Lambda).",
          { why: err.message },
        );
      } else {
        // Story 56-it2-04 P1-02: guard asymmetric error paths —
        // see the sibling comment in list.ts for the rationale.
        const message = err instanceof Error ? err.message : String(err);
        renderError(
          `Failed to validate --resource-type "${opts.resourceType}".`,
          "Check the value and try again — see `assignee admin status --help` for supported types.",
          { why: message },
        );
      }
      throw err;
    }
  }

  try {
    const resources = await fetchManagedResources(
      opts.region,
      resolvedResourceType,
    );

    if (resources.length === 0) {
      renderEmptyStatus();
      return;
    }

    // Fetch status data and cost anomalies in parallel
    const billingTools = await getBillingMcpToolsAsync();
    const [statusData, anomalies] = await Promise.all([
      buildStatusData(resources),
      billingTools ? queryCostAnomalies(billingTools) : ([] as CostAnomaly[]),
    ]);

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            ...statusData,
            ...(anomalies.length > 0 ? { costAnomalies: anomalies } : {}),
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    renderStatusSummary(statusData);

    // Render cost anomalies inline (non-blocking enhancement)
    if (anomalies.length > 0) {
      process.stdout.write("\nCost Anomalies:\n");
      for (const a of anomalies) {
        process.stdout.write(
          `  ${a.severity} | ${a.service} | impact: ${a.impact} | ${a.startDate}\n`,
        );
      }
    }
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    renderError(
      "Failed to fetch status.",
      "Check your AWS credentials and try again.",
      { why: err.message },
    );
    throw new AssigneeError(
      err.message || "Failed to fetch status.",
      "STATUS_ERROR",
    );
  }
}
