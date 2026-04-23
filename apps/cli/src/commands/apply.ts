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
import {
  AssigneeError,
  serializeErrorEnvelope,
  type JsonErrorDetail,
} from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ErrorCode } from "../constants/errors.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { resolveApplyArgs, type ApplyOpts } from "./apply/arg-parser.js";
import { runApply, type ApplyRunResult } from "./apply/orchestrator.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";

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
/**
 * Epic 96 Wave 1 B2: success envelope is enriched with optional
 * `runId` / `arn` / `cost` fields so CI pipelines can thread the
 * provisioned ARN + monthly cost downstream.
 *
 * Epic 98 e98.W5.N1 (Epic 97 A-01 + B-01): `primaryIdentifier` added
 * alongside `arn`. For non-taggable CFN constructs (Route /
 * SubnetRouteTableAssociation / VPCGatewayAttachment), AWS has no
 * standalone ARN so `arn` is emitted as literal `null` and the bare
 * CCAPI id lands in `primaryIdentifier` (which the W1.B1 destroy path
 * resolves via the dual-index provision log). For ARN-addressable
 * types, `arn` is the full `arn:<partition>:...` form and
 * `primaryIdentifier` is omitted. Automation pipelines that prefer
 * a single lookup key can read `.primaryIdentifier // .arn` and get
 * a destroy-able handle in every case.
 *
 * Undefined fields are elided by JSON.stringify (stable shape); the
 * deliberate `arn: null` for non-taggable types IS serialised as
 * `"arn": null` so downstream scripts can distinguish "no ARN
 * exists" from "ARN field missing due to early-exit".
 */
interface ApplySuccessEnvelope {
  ok: true;
  operation: string;
  runId?: string;
  arn?: string | null;
  primaryIdentifier?: string;
  cost?: string;
}

function installJsonStdoutSuppressor(enabled: boolean): {
  flushSuccess: (envelope: ApplySuccessEnvelope) => void;
  flushError: (
    code: string,
    message: string,
    hint?: string,
    detail?: JsonErrorDetail,
  ) => void;
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
    flushSuccess: (envelope) => {
      restore();
      const payload = JSON.stringify(envelope, null, 2) + "\n";
      originalWrite.call(process.stdout, payload);
    },
    flushError: (code, message, hint, detail) => {
      restore();
      originalWrite.call(
        process.stdout,
        serializeErrorEnvelope(code, message, hint, detail),
      );
    },
    restore,
  };
}

/**
 * Upper bound on the characters copied from `errorMessage` into
 * `error.detail.errorMessage` for the B-04 envelope closure. Prevents
 * a multi-kilobyte stack-trace-style string from bloating the JSON
 * envelope in automation pipelines.
 */
const ERROR_DETAIL_MAX_CHARS = 500;

/**
 * Epic 98 e98.W5.N4 (Epic 97 B-04 + B-05): synthesise an `AssigneeError`
 * from the orchestrator's typed `failure` classifier so the envelope
 * emits a specific code + message instead of the generic
 * "Apply failed: provisioning ended without success."
 *
 * - `bp_blocked` — message enumerates the blocking practice IDs so the
 *   human-readable message is actionable ("Blocked by BP-IGW-001"),
 *   and `error.detail.practiceIds[]` carries the machine-readable form.
 * - `apply_failed` — message is the concrete `finalState.errorMessage`
 *   passed up from the result-formatter (truncated to 500 chars at
 *   the envelope boundary to keep stdout bounded).
 * - No `failure` attached — fall back to the pre-N4 generic message so
 *   existing callers / Phase-1 CANCELLED paths stay byte-identical.
 *
 * `alreadyRendered: true` is set on every branch because the
 * human-readable block is already on stderr via renderError /
 * renderProvisioningLoop — we must NOT let index.ts double-paint it.
 */
function synthesiseFailureError(result: ApplyRunResult): AssigneeError {
  const failure = result.failure;
  if (failure?.kind === "bp_blocked") {
    const idsSummary =
      failure.practiceIds.length > 0
        ? failure.practiceIds.join(", ")
        : "an unspecified blocking finding";
    return new AssigneeError(
      `Apply blocked by best-practice findings: ${idsSummary}.`,
      ErrorCode.BP_BLOCKED,
      { alreadyRendered: true },
    );
  }
  if (failure?.kind === "apply_failed") {
    return new AssigneeError(
      truncate(failure.errorMessage, ERROR_DETAIL_MAX_CHARS),
      ErrorCode.APPLY_FAILED,
      { alreadyRendered: true },
    );
  }
  return new AssigneeError(
    "Apply failed: provisioning ended without success.",
    ErrorCode.APPLY_FAILED,
    { alreadyRendered: true },
  );
}

/**
 * Project the orchestrator's typed `failure` classifier onto the JSON
 * envelope's `error.detail` bag. Returns `undefined` when there is no
 * failure payload (Phase-1 CANCELLED / success paths / plain-Error
 * throws) so the serialiser omits the `detail` key entirely and the
 * pre-N4 envelope shape is preserved byte-for-byte.
 */
function buildErrorDetail(
  failure: ApplyRunResult["failure"],
): JsonErrorDetail | undefined {
  if (failure === undefined) return undefined;
  if (failure.kind === "bp_blocked") {
    if (failure.practiceIds.length === 0) return undefined;
    return { practiceIds: failure.practiceIds };
  }
  if (failure.kind === "apply_failed") {
    if (!failure.errorMessage) return undefined;
    return {
      errorMessage: truncate(failure.errorMessage, ERROR_DETAIL_MAX_CHARS),
    };
  }
  return undefined;
}

/** Truncate `s` to at most `max` chars with a `…` elision marker. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Build the top-level success envelope from the orchestrator's
 * `ApplyRunResult`. Only defined fields are projected into the final
 * object so `JSON.stringify` doesn't emit keys with undefined values.
 */
function buildSuccessEnvelope(
  result: ApplyRunResult | null,
): ApplySuccessEnvelope {
  const envelope: ApplySuccessEnvelope = { ok: true, operation: "apply" };
  if (result?.runId) envelope.runId = result.runId;
  // Epic 98 e98.W5.N1: `arn` is emitted as `null` for non-taggable
  // constructs (no standalone AWS ARN exists). Distinguish that from
  // `arn=undefined` (Phase-1 early-exit — nothing provisioned yet) by
  // testing `arn !== undefined` rather than truthiness.
  if (result?.arn !== undefined) envelope.arn = result.arn;
  if (result?.primaryIdentifier) {
    envelope.primaryIdentifier = result.primaryIdentifier;
  }
  if (result?.cost) envelope.cost = result.cost;
  return envelope;
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
    // Epic 96 Wave 3 N4 (D-04): under `--json`, suppress the human
    // `[ERROR]/[CONTEXT]/[FIX]` blocks that renderError emits on stderr.
    // Structured JSON log lines stay visible; only prefix-matched
    // human-error writes are dropped. Same payload (code/message/hint)
    // is emitted on stdout as the error envelope, so the duplicated
    // stderr block is pure noise for machine consumers.
    const stderrFilter = installJsonStderrFilter(jsonMode);

    try {
      let runErrored: Error | null = null;
      // Epic 96 Wave 1 B2: capture the orchestrator's enriched result
      // so the CLI can (a) emit `runId` / `arn` / `cost` in the JSON
      // success envelope and (b) flip a `success=false` short-circuit
      // (Phase-1 gate terminal) into a thrown AssigneeError with
      // APPLY_FAILED — the same exit/envelope contract a Phase-2
      // provisioning failure produces.
      const applyResultRef: { current: ApplyRunResult | null } = {
        current: null,
      };
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
          run: async (ctx) => {
            const result = await runApply(ctx, {
              opts,
              intent,
              effectiveIntent,
              resolvedCheckpoint,
              resolvedSourceDir,
              sourceFileCount,
            });
            applyResultRef.current = result;
            return result;
          },
        });
      } catch (err) {
        runErrored = err instanceof Error ? err : new Error(String(err));
      }

      const applyResult = applyResultRef.current;

      // Epic 96 Wave 1 B2 (A-02): if the orchestrator ran to completion
      // but returned success=false (provisioning FAILED / bp-blocked /
      // unexpected status), synthesise an AssigneeError so the envelope
      // + exit-code path below fires. The human-readable error block
      // has already been written to stderr by `runProvisioningLoop` or
      // the Phase-1 gate; `alreadyRendered:true` prevents the top-level
      // Commander catch from painting the message a second time.
      //
      // Epic 98 e98.W5.N4 (B-04 + B-05): branch on `applyResult.failure`
      // so the synthesised error carries the right code (BP_BLOCKED vs
      // APPLY_FAILED) and a concrete message (the Phase-2
      // `errorMessage` rather than the generic "provisioning ended
      // without success"). The structured `failure` payload is also
      // stamped onto `error.detail` when the JSON envelope flushes
      // below so automation has machine-readable practice IDs / the
      // concrete AWS error without parsing stderr JSON-lines.
      if (!runErrored && applyResult && applyResult.success === false) {
        runErrored = synthesiseFailureError(applyResult);
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
          // Epic 98 e98.W5.N4: attach `error.detail` when the failure
          // came from the orchestrator with structured classification.
          // External throws (plain Errors, other AssigneeError paths)
          // get `undefined` → serializer omits the detail key entirely.
          const detail = buildErrorDetail(applyResult?.failure);
          suppressor.flushError(code, runErrored.message, hint, detail);
        } else {
          suppressor.flushSuccess(buildSuccessEnvelope(applyResult));
        }
      }

      if (runErrored) {
        // Rethrow as alreadyRendered so the top-level Commander catch
        // in index.ts does not double-paint (stderr already carries
        // the human block from runCommand's renderError hook).
        if (runErrored instanceof AssigneeError) {
          throw jsonMode || runErrored.alreadyRendered
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
      stderrFilter.restore();
    }
  });
