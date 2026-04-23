/**
 * `assignee reconcile` command — reconciles drifted resources back to desired state.
 *
 * Wave-6d F4: decomposed into `reconcile/` sub-modules. This file is
 * now a thin Commander wrapper + re-export surface so existing
 * consumers (tests, reconcile-factory) keep working.
 *
 * Epic 94 Wave 2 N4 (D-08): added `--json` / `-o, --output <format>`
 * for parity with plan/list/apply/destroy. In JSON mode, every stdout
 * write inside `runReconcile` (drift status lines, reconcile summary)
 * is suppressed; a single top-level envelope is emitted at the end.
 *   - success: `{ok:true, operation:"reconcile"}`
 *   - failure: `{ok:false, error:{code,message,hint}}` using the
 *     Wave 94.R5 `AssigneeError` classification.
 * Plaintext mode is unchanged.
 *
 * @see Story 28.4
 * @see _bmad-output/implementation-artifacts/94-n4-apply-destroy-reconcile-json.md
 */

import { Command } from "commander";
import { AssigneeError, serializeErrorEnvelope } from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  ReconcileAction,
  type ReconcileActionType,
} from "../constants/reconcile-actions.js";
import { runReconcile } from "./reconcile/orchestrator.js";
import type { ReconcileOpts } from "./reconcile/types.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";

// ── Re-exports for external consumers (tests, reconcile-factory) ──────────
export { ReconcileAction, type ReconcileActionType };
export type {
  ReconcileSummary,
  PromptFn,
  ConfirmFn,
} from "./reconcile/types.js";
export {
  buildPatchDocument,
  escapeJsonPointerSegment,
  fieldPathToJsonPointer,
  fieldPathToSchemaPointer,
} from "./reconcile/patch-builder.js";
export { reconcileResource } from "./reconcile/apply-step.js";

/**
 * Epic 94 Wave 2 N4 (D-08): stdout suppressor for `--json` mode.
 * Mirrors the helpers added to plan.ts/apply.ts/destroy.ts.
 *
 * Epic 96 Wave 1 B2 (A-02): success envelope carries an optional
 * `runId` so reconcile output parses alongside apply/destroy for
 * downstream correlation. `arn` and `cost` are not threaded through
 * `runReconcile` today (reconcile operates on N resources — the
 * envelope would need a per-resource list; that's out of scope for
 * this blocker and is left as a follow-up).
 */
interface ReconcileSuccessEnvelope {
  ok: true;
  operation: string;
  runId?: string;
}

function installJsonStdoutSuppressor(enabled: boolean): {
  flushSuccess: (envelope: ReconcileSuccessEnvelope) => void;
  flushError: (code: string, message: string, hint?: string) => void;
  restore: () => void;
} {
  if (!enabled) {
    return {
      flushSuccess: () => {},
      flushError: () => {},
      restore: () => {},
    };
  }
  const originalWrite = process.stdout.write;
  process.stdout.write = ((
    _chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    process.stdout.write = originalWrite;
    restored = true;
  };

  return {
    flushSuccess: (envelope) => {
      restore();
      originalWrite.call(
        process.stdout,
        JSON.stringify(envelope, null, 2) + "\n",
      );
    },
    flushError: (code, message, hint) => {
      restore();
      originalWrite.call(
        process.stdout,
        serializeErrorEnvelope(code, message, hint),
      );
    },
    restore,
  };
}

type ReconcileOptsWithJson = ReconcileOpts & {
  json?: boolean;
  output?: string;
};

export const reconcileCommand = new Command(CommandName.RECONCILE)
  .description(CommandDescription.RECONCILE)
  .option("--resource <type>", "Filter by resource type")
  .option("--dry-run", "Show what would be reconciled without making changes")
  .option(
    "-y, --yes",
    "Non-interactive mode — reconcile every drifted resource without prompting (canonical CI flag)",
  )
  .option(
    "--auto-reconcile",
    "(deprecated alias for --yes) Reconcile all drifted resources without prompting. Prefer --yes; this alias is retained for backward compatibility and may be removed in a future major version.",
  )
  // Epic 94 N4 (D-08): parity with plan/list/apply/destroy.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option(
    "--json",
    "Shorthand for --output json (emit machine-readable envelope)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee reconcile
        Detect drift and prompt per-resource (interactive)
  $ assignee reconcile --dry-run
        Preview reconcile decisions without calling AWS
  $ assignee reconcile --yes
        Reconcile every drifted resource (CI-friendly)
  $ assignee reconcile --resource AWS::S3::Bucket --yes
        Reconcile only S3 buckets, non-interactive
  $ assignee reconcile --yes --json
        Machine-readable envelope for CI scripts
`,
  )
  .action(async (rawOpts: ReconcileOptsWithJson) => {
    const json = rawOpts.json === true || rawOpts.output === "json";
    const suppressor = installJsonStdoutSuppressor(json);
    // Epic 96 Wave 3 N4 (D-04): suppress renderError human blocks on
    // stderr under JSON mode. Structured JSON log lines pass through;
    // only [ERROR]/[CONTEXT]/[FIX] prefix writes are dropped.
    const stderrFilter = installJsonStderrFilter(json);

    try {
      let runErrored: Error | null = null;
      try {
        // runReconcile expects ReconcileOpts — json/output keys are
        // irrelevant downstream; we pass the original object through.
        // Extra keys are harmless (ReconcileOpts is an interface with
        // optional fields; excess keys don't alter behaviour).
        await runReconcile(rawOpts);
      } catch (err) {
        runErrored = err instanceof Error ? err : new Error(String(err));
      }

      if (json) {
        if (runErrored) {
          const isTyped = runErrored instanceof AssigneeError;
          const code = isTyped
            ? (runErrored as AssigneeError).code
            : "UNKNOWN_ERROR";
          const hint = isTyped
            ? ((runErrored as { hint?: string }).hint ??
              "Check AWS credentials and run `assignee drift` for details.")
            : "Run with --verbose for full stack trace.";
          suppressor.flushError(code, runErrored.message, hint);
        } else {
          suppressor.flushSuccess({ ok: true, operation: "reconcile" });
        }
      }

      if (runErrored) {
        if (json) {
          const code =
            runErrored instanceof AssigneeError
              ? runErrored.code
              : "UNKNOWN_ERROR";
          throw new AssigneeError(runErrored.message, code, {
            alreadyRendered: true,
          });
        }
        throw runErrored;
      }
    } finally {
      suppressor.restore();
      stderrFilter.restore();
    }
  });
