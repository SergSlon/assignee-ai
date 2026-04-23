/**
 * `assignee plan` command — Sprint 1 demo gate.
 * Runs the graph in plan mode (no HITL, no provisioning), outputs a formatted plan box.
 *
 * Wave-6d F4: decomposed into `plan/` sub-modules. This file is now a
 * thin Commander wrapper + `runCommand` bridge.
 *
 * Epic 92 Wave 2.c (A-02 / B-04 / D-29): in `--output json` mode the
 * formatter at `graph/nodes/result-formatter/formatters/plan.ts` writes
 * one JSON object per resource (NDJSON). That formatter is owned by a
 * different fix wave (4.a) and cannot be touched here. We therefore
 * install a stdout interceptor at the CLI layer: every byte the
 * formatter writes to stdout is buffered, then on command exit we
 * aggregate via `serializePlanEnvelope` / `serializeErrorEnvelope`
 * and write a SINGLE top-level JSON value (object with `plans` array
 * for compound plans, or an `ok:false` envelope on error). The
 * registry/help block that `renderError` would normally write to
 * stderr is already stderr-routed; this layer adds the machine-
 * readable envelope on stdout.
 *
 * Epic 92 Wave 3.b.1 (C-24 / D-01 / D-13): the help surface gained
 *   a. a single consolidated `addHelpText("after", ...)` block (prior
 *      help had two Examples headers — global + per-command),
 *   b. `--wizard` registered as a synonym for `--quick` because the
 *      canonical flag name is `--quick` but docs/agent transcripts
 *      reference the user-facing term `--wizard`, and
 *   c. `--json` registered as a boolean shorthand for `--output json`
 *      so plan matches list/status/doctor/optimize/drift flag naming.
 *   The action normalizes `opts.wizard` → `opts.quick` and
 *   `opts.json` → `opts.output = "json"` before `resolvePlanArgs`,
 *   leaving downstream modules untouched.
 *
 * @see Story 1-6, Story 1-8, Story 9-6
 * @see _bmad-output/implementation-artifacts/e92-2c-json-envelope.md
 * @see _bmad-output/implementation-artifacts/e92-3b1-plan-apply-help.md
 */

import { Command } from "commander";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { LOG_ACTIONS } from "../utils/logger.js";
import { runCommand } from "../utils/command-runner.js";
import {
  SUPPORTED_TYPES_HINT,
  PLAN_GENERATION_FAILED,
  EXAMPLE_S3_INTENT,
} from "../config/constants.js";
import {
  AssigneeError,
  parsePlanJsonStream,
  serializePlanEnvelope,
  serializeErrorEnvelope,
} from "@assignee/core";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { resolvePlanArgs, type PlanOpts } from "./plan/arg-parser.js";
import { renderDiscoveryBlock } from "./plan/discovery.js";
import { runPlan } from "./plan/orchestrator.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";

/**
 * Buffering stdout interceptor used when `--output json` is active.
 *
 * Replaces `process.stdout.write` with a capture function so the
 * formatter's per-resource `JSON.stringify(...)` calls land in memory
 * rather than emitting NDJSON. On flush, the buffered text is parsed
 * via `parsePlanJsonStream` and re-emitted as a single envelope.
 *
 * Side-effect-free for callers in text mode — `install` only hooks
 * when `enabled` is true, and the restore callback always resets to
 * the original `write`.
 */
function installJsonStdoutInterceptor(enabled: boolean): {
  flushSuccess: () => void;
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
  // Capture by reference (NOT `.bind(process.stdout)`) so `restore()`
  // puts back the exact same function object the test harness spied
  // on. A bound wrapper has a different identity and breaks
  // spy-identity assertions in downstream tests.
  const originalWrite = process.stdout.write;
  let buffered = "";
  // Replace stdout.write. We only capture strings / Buffers that look
  // like JSON payloads; any other writes are let through verbatim so
  // incidental noise (if any) remains observable during debugging.
  // The formatter itself writes exactly `JSON.stringify(...) + "\n"`,
  // which always starts with `{` — that's our capture condition.
  process.stdout.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const trimmedStart = text.trimStart();
    if (trimmedStart.startsWith("{")) {
      buffered += text;
      // Invoke the optional callback if one was provided so the caller's
      // write-result contract is preserved.
      const cb = rest.find((r) => typeof r === "function") as
        | ((err?: Error | null) => void)
        | undefined;
      if (cb) cb();
      return true;
    }
    return (
      originalWrite as (this: NodeJS.WriteStream, ...args: unknown[]) => boolean
    ).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;

  const restore = (): void => {
    process.stdout.write = originalWrite;
  };

  return {
    flushSuccess: () => {
      const payloads = parsePlanJsonStream(buffered);
      restore();
      if (payloads.length === 0) {
        // No per-resource payloads were buffered — this happens when
        // the plan failed BEFORE the formatter had a chance to write
        // (e.g. UNSUPPORTED_RESOURCE exits early via renderError). The
        // orchestrator returns `{ success: false }` in that case and
        // runCommand returns normally without throwing, so our outer
        // error-envelope path is not triggered. Emit a bare
        // PLAN_FAILED envelope so consumers always see a parseable
        // JSON value on stdout.
        originalWrite.call(
          process.stdout,
          serializeErrorEnvelope(
            "PLAN_FAILED",
            "Plan generation did not produce any output.",
            "See stderr for the human-readable error message, or run `assignee --verbose plan <intent>` to trace.",
          ),
        );
        return;
      }
      originalWrite.call(process.stdout, serializePlanEnvelope(payloads));
    },
    flushError: (code, message, hint) => {
      // On error the user may or may not have also produced plan
      // payloads before the failure. The contract for machine readers
      // is a SINGLE JSON value, so we discard any partial success
      // buffer and emit only the error envelope.
      buffered = "";
      restore();
      originalWrite.call(
        process.stdout,
        serializeErrorEnvelope(code, message, hint),
      );
    },
    restore,
  };
}

export const planCommand = new Command(CommandName.PLAN)
  .description(CommandDescription.PLAN)
  .argument(CommandArgs.INTENT.NAME, CommandArgs.INTENT.DESC)
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option(
    "--json",
    "Shorthand for --output json (emit machine-readable envelope)",
  )
  .option("--no-apply", "Skip the apply prompt after plan display")
  .option("--no-advice", "Skip inline contextual advice generation")
  .option(
    "-s, --source <path>",
    "Path to local files to upload after provisioning (e.g., static site)",
  )
  // Epic 92 u.e (C-11 / C-17): `--set <key=value>` is REPEATABLE but
  // NOT variadic. `--set key=value...` (variadic) consumed the positional
  // intent when the user typed `plan --set size=t3.medium "Create EC2"`
  // because Commander interpreted the intent string as another `--set`
  // argument. Each `--set` now accepts exactly one token and the
  // collector appends to an array — same UX surface, no intent loss.
  // Token syntax is validated in `resolvePlanArgs` so the error path
  // emits an actionable `[ERROR]` hint instead of silently ignoring a
  // malformed `--set novalue`.
  .option(
    "--set <key=value>",
    "Pre-set field values (repeatable), supports human names (e.g., --set size=t3.medium)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "-y, --yes",
    "Accepted for CI wrapper compatibility; plan is read-only and does not mutate.",
  )
  .option(
    "-q, --quick",
    "Skip wizard prompts that have defaults — only ask for required fields without a default. Shows a summary gate before generating the plan.",
  )
  .option(
    "--wizard",
    "Alias for --quick; runs the wizard flow that asks only for required fields without a default.",
  )
  // Epic 92 Wave 3.b.1 (C-24 / D-01): single consolidated Examples +
  // discovery block — previously composed as two separate addHelpText
  // calls which rendered back-to-back "Examples:" headers in
  // `plan --help`. Lazily rendered via a function so construction of
  // the Command object has zero runtime cost when --help is not
  // requested.
  .addHelpText(
    "after",
    () =>
      `\n${SUPPORTED_TYPES_HINT}\n\nExamples:\n  assignee plan "${EXAMPLE_S3_INTENT}"\n  assignee plan "Create an EC2 t3.micro instance"\n  assignee plan "Create a Lambda function for image processing"\n  assignee plan --json "Create an S3 bucket"\n  assignee plan --wizard "Create an EC2 instance"\n  assignee plan --set size=t3.medium "Create an EC2 instance"\n\n${renderDiscoveryBlock()}`,
  )
  .action(async (intent: string | undefined, rawOpts: PlanOpts) => {
    // Epic 92 Wave 3.b.1 (D-13): `--wizard` is a user-facing synonym
    // for the canonical `--quick` flag; `--json` is a shorthand for
    // `--output json`. Normalize at the CLI boundary so the rest of
    // the pipeline (resolvePlanArgs / runPlan) only needs to read
    // `opts.quick` and `opts.output`. Commander v12 does not support
    // multi-long-alias in a single `.option()` call — each synonym
    // is a separate boolean option and coalesces here. The local
    // `PlanOptsWithAliases` widens `PlanOpts` to expose the synonym
    // keys without mutating the shared arg-parser contract.
    type PlanOptsWithAliases = PlanOpts & { wizard?: boolean; json?: boolean };
    const aliasOpts = rawOpts as PlanOptsWithAliases;
    const opts: PlanOpts = { ...rawOpts };
    if (aliasOpts.wizard === true && opts.quick !== true) {
      opts.quick = true;
    }
    if (
      aliasOpts.json === true &&
      (opts.output === undefined || opts.output === "text")
    ) {
      opts.output = "json";
    }

    // Epic 94 N3 (A-03 / A-09): install the interceptor BEFORE arg
    // parsing so that AssigneeError throws from `resolvePlanArgs`
    // (empty intent, malformed `--set`) still emit a clean
    // `{ok:false, error:{code,message,hint}}` envelope on stdout in
    // JSON mode. Before this change, arg-parse ran outside the try
    // block, bubbled to Commander, and stdout stayed empty → `jq`
    // fails with no JSON input.
    //
    // `outputFormat` is read off `opts.output` here (pre-arg-parse)
    // because `resolvePlanArgs` only defaults to `"text"` — it does
    // NOT alter the value the user passed via `--output` / `--json`.
    // So reading `opts.output ?? "text"` at the CLI boundary
    // produces the same result as `resolved.outputFormat`.
    const outputFormat = opts.output ?? "text";

    // P2-R2-4: print resolved AWS context before any mutation-capable
    // step so the operator always sees which account/region/profile the
    // plan will target. Suppressed in JSON mode to keep stdout clean.
    if (outputFormat !== "json") {
      const ctx = await resolveIntroContext();
      process.stderr.write(`assignee plan  [${formatIntroContext(ctx)}]\n`);
    }

    // Epic 92 Wave 2.c: wrap stdout in JSON mode so the per-resource
    // payloads from the formatter land in an aggregator instead of
    // streaming as NDJSON. See installJsonStdoutInterceptor.
    const interceptor = installJsonStdoutInterceptor(outputFormat === "json");
    // Epic 96 Wave 3 N4 (D-04): suppress renderError human
    // `[ERROR]/[CONTEXT]/[FIX]` blocks on stderr under JSON mode.
    // Structured JSON log lines pass through; the same code/message/
    // hint payload is emitted on stdout as the error envelope, so the
    // duplicated stderr block is pure noise for machine consumers.
    const stderrFilter = installJsonStderrFilter(outputFormat === "json");

    try {
      let runErrored: Error | null = null;
      try {
        // Epic 94 N3: arg-parse moved INSIDE the try so AssigneeError
        // throws (MISSING_INTENT / BAD_SET_SYNTAX) get routed through
        // the R5 envelope pipeline below instead of bubbling past the
        // interceptor.
        const resolved = resolvePlanArgs(intent, opts);
        await runCommand({
          intent: intent!,
          commandName: "plan",
          startAction: LOG_ACTIONS.PLAN_STARTED,
          endAction: LOG_ACTIONS.PLAN_COMPLETE,
          errorPrefix: PLAN_GENERATION_FAILED,
          errorHint:
            "Check that AWS credentials are configured and Bedrock is accessible in your region.",
          silent: outputFormat === "json",
          run: async (ctx) =>
            runPlan(ctx, {
              ...resolved,
              intent: intent!,
              opts: { advice: opts.advice, quick: opts.quick === true },
            }),
        });
      } catch (err) {
        runErrored = err instanceof Error ? err : new Error(String(err));
      }

      if (outputFormat === "json") {
        if (runErrored) {
          // Shape the envelope from the thrown error. The renderError
          // block (WHY/FIX text + registry) already went to stderr; we
          // only need the structured code/message/hint on stdout.
          //
          // Epic 94 R5 (C-03): distinguish TYPED failures (AssigneeError
          // with a stable `.code` from the error hierarchy) from
          // UNKNOWN failures (plain Error or thrown non-Error). Typed
          // errors keep their own code + hint; unknown errors get the
          // `UNKNOWN_ERROR` sentinel + a `--verbose` hint so machine
          // readers can filter "pipeline did not model this" from
          // "pipeline ran and raised a known failure".
          const isTyped = runErrored instanceof AssigneeError;
          const code = isTyped
            ? (runErrored as AssigneeError).code
            : "UNKNOWN_ERROR";
          const hint = isTyped
            ? ((runErrored as { hint?: string }).hint ??
              "Try rephrasing your intent, or run `assignee --verbose plan <intent>` to see the full node trace.")
            : "Run with --verbose for full stack trace.";
          interceptor.flushError(code, runErrored.message, hint);
        } else {
          interceptor.flushSuccess();
        }
      }

      if (runErrored) throw runErrored;
    } finally {
      interceptor.restore();
      stderrFilter.restore();
    }
  });
