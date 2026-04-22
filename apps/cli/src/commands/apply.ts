/**
 * `assignee apply` command — two-phase HITL invoke pattern.
 *
 * Phase 1: graph runs intent_parser → schema_fetcher → option_elicitor →
 *          compound_dispatcher → plan_generator → preflight_guard → human_approval,
 *          then pauses (interruptBefore: resource_provisioner).
 * Phase 2: while loop — each iteration resumes from a resource_provisioner interrupt.
 *          Single-resource: one iteration. Compound: N iterations in dependency order.
 *
 * --yes flag: auto-confirms HITL for CI/CD (Story 11.2). Preflight is never bypassed.
 * --checkpoint flag: loads a saved checkpoint, skipping Phase 1 entirely (Story 11.3).
 *
 * Wave-6c F2: decomposed into `apply/` sub-modules. This file is now a thin
 * Commander wrapper + `runCommand` bridge. All real logic lives under `apply/`.
 *
 * Epic 92 Wave 3.b.1 (C-24 / D-02 / D-13): the help surface was
 * collapsed into a SINGLE `addHelpText("after", ...)` block and the
 * Examples section now shows apply-specific invocations (previously
 * it contained `assignee plan "..."` entries leaked from the plan
 * command). The flag surface keeps the existing `--wizard` (opt-in
 * interactive wizard, wires to `noWizard=false` in phase1-planner)
 * and `--quick` (skip defaulted prompts) — both are preserved
 * because they carry distinct graph-state semantics that downstream
 * tests rely on (`apply-action.test.ts` T1.4, phase1-planner.ts).
 *
 * Epic 94 Wave 2 N4 (A-14): `--json` / `-o, --output <format>` added
 * so scripts that pipe `plan --json` can also pipe `apply` output.
 * In JSON mode, a stdout suppressor buffers every byte the inner
 * action writes (so `renderPlanBox` / `renderApplySuccess` don't
 * pollute the machine stream). On completion we emit exactly one
 * top-level envelope:
 *   - success: `{ok:true, operation:"apply"}`
 *   - failure: `{ok:false, error:{code,message,hint}}` using the
 *     Wave 94.R5 `AssigneeError` classification.
 * Plaintext behaviour is byte-identical to pre-N4 — every existing
 * assertion in `apply.test.ts` stays green.
 *
 * @see Story 2-6, Story 1-8, Story 9-6, Story 11-2, Story 11-3
 * @see _bmad-output/implementation-artifacts/e92-3b1-plan-apply-help.md
 * @see _bmad-output/implementation-artifacts/94-n4-apply-destroy-reconcile-json.md
 */

import { Command } from "commander";
import { AssigneeError, serializeErrorEnvelope } from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { resolveApplyArgs, type ApplyOpts } from "./apply/arg-parser.js";
import { runApply } from "./apply/orchestrator.js";

/**
 * Buffering stdout suppressor used when `--output json` is active.
 *
 * Replaces `process.stdout.write` with a black-hole function so the
 * inner action's text renderers (`renderPlanBox`, `renderApplySuccess`,
 * etc.) do not pollute the machine stream. On `flushSuccess()` /
 * `flushError()` we restore the original writer and emit exactly one
 * top-level envelope through it.
 *
 * Mirrors the pattern used by `plan.ts` (Wave 92.2.c) but cheaper — we
 * don't need per-resource NDJSON aggregation, just a single envelope.
 */
function installJsonStdoutSuppressor(enabled: boolean): {
  flushSuccess: (operation: string) => void;
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
  // Capture the original by reference (NOT `.bind(...)`) so restore()
  // puts back the exact function-identity the test harness may have
  // spied on.
  const originalWrite = process.stdout.write;
  // Suppress all stdout writes while JSON mode is active. Any byte
  // that would otherwise appear on stdout gets dropped; the inner
  // action's callers see a successful synchronous write. Stderr is
  // untouched so log events + human error blocks still render.
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
    flushSuccess: (operation) => {
      restore();
      const payload = JSON.stringify({ ok: true, operation }, null, 2) + "\n";
      originalWrite.call(process.stdout, payload);
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

/**
 * Options recognised by the outer Commander wrapper BEYOND the `ApplyOpts`
 * consumed by `resolveApplyArgs`. Only `json` / `output` are read here —
 * the rest flow through to `runApply` untouched.
 */
type ApplyOptsWithJson = ApplyOpts & { json?: boolean; output?: string };

export const applyCommand = new Command(CommandName.APPLY)
  .description(CommandDescription.APPLY)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option(
    "--wizard",
    "Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent)",
  )
  .option(
    "-q, --quick",
    "Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before provisioning.",
  )
  .option("--no-advice", "Skip inline contextual advice generation")
  .option(
    "-y, --yes",
    "Auto-confirm apply without interactive prompt (for CI/CD)",
  )
  .option(
    "-c, --checkpoint <path>",
    "Use a saved plan checkpoint instead of running Phase 1",
  )
  .option(
    "-s, --source <path>",
    "Path to local files to upload after provisioning (e.g., static site)",
  )
  .option(
    "--set <key=value...>",
    "Pre-set wizard field values (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  // Epic 94 N4 (A-14): `--output <format>` + `--json` shorthand. Mirrors
  // the plan-command flag surface so scripts that pipe `plan --json` can
  // follow through with `apply --json` and receive a parseable envelope.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option(
    "--json",
    "Shorthand for --output json (emit machine-readable envelope)",
  )
  // Epic 92 Wave 3.b.1 (C-24 / D-02): ONE consolidated addHelpText
  // block with APPLY-specific examples. Before this fix the Examples
  // block leaked `assignee plan "..."` invocations under
  // `assignee apply --help`.
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee apply "${EXAMPLE_S3_INTENT}"\n  assignee apply --yes "Create an S3 bucket"\n  assignee apply --checkpoint .assignee/checkpoint-abc.json\n  assignee apply --wizard "Create an EC2 instance"\n  assignee apply --set size=t3.medium "Create an EC2 instance"\n  assignee apply --json --yes "Create an S3 bucket"`,
  )
  .action(async (intent: string | undefined, rawOpts: ApplyOptsWithJson) => {
    // Normalise `--json` → `--output json` (same collapse plan.ts
    // performs). Reading `rawOpts.output ?? "text"` gives the canonical
    // value for the rest of the action.
    const opts: ApplyOptsWithJson = { ...rawOpts };
    if (
      rawOpts.json === true &&
      (opts.output === undefined || opts.output === "text")
    ) {
      opts.output = "json";
    }
    const outputFormat = opts.output ?? "text";
    const jsonMode = outputFormat === "json";

    // P2-R2-4: print resolved AWS context as the very first line so the
    // operator sees WHICH account/region/profile is about to be mutated
    // before any spinner / prompt / LLM call runs. Suppressed in JSON
    // mode to keep stderr cleaner for log scrapers (but still on stderr,
    // not stdout — same discipline as plan).
    if (!jsonMode) {
      const introCtx = await resolveIntroContext();
      process.stderr.write(
        `assignee apply  [${formatIntroContext(introCtx)}]\n`,
      );
    }

    const suppressor = installJsonStdoutSuppressor(jsonMode);

    try {
      let runErrored: Error | null = null;
      try {
        const {
          resolvedCheckpoint,
          resolvedSourceDir,
          sourceFileCount,
          effectiveIntent,
        } = await resolveApplyArgs(intent, opts);

        await runCommand({
          intent: effectiveIntent,
          commandName: "apply",
          startAction: LOG_ACTIONS.APPLY_STARTED,
          endAction: LOG_ACTIONS.APPLY_COMPLETE,
          errorPrefix: "Apply failed",
          errorHint:
            "Check that AWS credentials are configured and all MCP servers are running.",
          // In JSON mode, runCommand's intro/outro banners + spinner
          // would also write to stdout; `silent:true` routes them to
          // the no-op path (same invariant Wave 2.c added for plan).
          silent: jsonMode,
          run: async (ctx) =>
            runApply(ctx, {
              opts,
              intent,
              effectiveIntent,
              resolvedCheckpoint,
              resolvedSourceDir,
              sourceFileCount,
            }),
        });
      } catch (err) {
        runErrored = err instanceof Error ? err : new Error(String(err));
      }

      if (jsonMode) {
        if (runErrored) {
          // Same Wave 94.R5 classification plan.ts uses: typed
          // AssigneeError keeps its own `.code`/`.hint`; plain Errors
          // land under `UNKNOWN_ERROR` with a verbose-trace hint.
          const isTyped = runErrored instanceof AssigneeError;
          const code = isTyped
            ? (runErrored as AssigneeError).code
            : "UNKNOWN_ERROR";
          const hint = isTyped
            ? ((runErrored as { hint?: string }).hint ??
              "Run `assignee --verbose apply` to see the full node trace.")
            : "Run with --verbose for full stack trace.";
          suppressor.flushError(code, runErrored.message, hint);
        } else {
          suppressor.flushSuccess("apply");
        }
      }

      if (runErrored) {
        // Rethrow as alreadyRendered so the top-level Commander catch
        // in index.ts does not double-paint (stderr already carries
        // the human block from runCommand's renderError hook).
        if (runErrored instanceof AssigneeError) {
          throw jsonMode
            ? new AssigneeError(runErrored.message, runErrored.code, {
                alreadyRendered: true,
              })
            : runErrored;
        }
        throw jsonMode
          ? new AssigneeError(runErrored.message, "UNKNOWN_ERROR", {
              alreadyRendered: true,
            })
          : runErrored;
      }
    } finally {
      suppressor.restore();
    }
  });
