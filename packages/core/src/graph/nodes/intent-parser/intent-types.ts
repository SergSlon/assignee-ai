// ---------------------------------------------------------------------------
// intent-parser/intent-types.ts — canonical shared types.
// ---------------------------------------------------------------------------
//
// RW7-merge artefact. The decomposed cluster files (extractors/name-extractor.ts
// in particular) currently inline a private copy of `Advisory` to keep the
// parallel-extraction window self-contained. This module is the canonical
// single source of truth — a follow-up dedupe micro-wave will swap each
// cluster's inline copy for an import from this file. The current commit
// only ADDS the canonical declarations; it does not yet rewire the cluster
// files (per the RW7-merge worker brief — file ownership is exclusive to
// this wave's three files).
//
// External callers (graph-state.ts, plan-generator.ts, preflight-guard.ts,
// result-formatter/formatters/plan.ts) import `Advisory` from
// `./intent-parser.js` (via the shim). The shim re-exports `* from
// "./intent-parser/index.js"`, which in turn re-exports the types from
// here. Existing import paths therefore keep working unchanged.

/**
 * Structured advisory attached to the plan envelope when the parser
 * silently drops or alters a user-supplied token (e.g. the trailing
 * words of a multi-word `named` clause). Distinct from `errors[]`
 * which halts the plan — advisories are non-blocking diagnostics the
 * user should see but which don't invalidate the intent.
 *
 * Epic 94 Wave 1 fixer e94.R8 — closes A-06 (MED REGRESSION): before
 * this, `named bad bucket name` silently captured `bad` and dropped
 * `bucket name` with no user signal.
 *
 * Epic 94 Wave 2 fixer e94.N5 — extended with optional `details` to
 * carry structured `{from, to}` diffs for `NAME_REWRITTEN` and
 * `BP_ADJUSTED_VALUE` advisories. Additive field — pre-N5 consumers
 * read only `code` / `message` / `hint` and continue to work.
 */
export interface Advisory {
  /** Stable machine-readable code (e.g. `NAME_REMAINDER_IGNORED`). */
  code: string;
  /** Human-readable summary of what was dropped or altered. */
  message: string;
  /** Actionable fix hint so the user can rephrase. */
  hint: string;
  /**
   * Optional structured payload — e.g. `{from: "192.168.1.1", to:
   * "ip-192-168-1-1"}` for NAME_REWRITTEN, or `{field:
   * "RetentionInDays", from: 14, to: 30}` for BP_ADJUSTED_VALUE.
   * Consumers that pre-date N5 ignore this field.
   */
  details?: Record<string, unknown>;
}

/**
 * Result envelope for `extractAssertedValues`. The orchestrator merges
 * `elicited` into graph-state `elicitedOptions` (and scalar values into
 * `presetFields`); `errors[]` halts the plan via a FAILED partial
 * state; `advisories[]` are concatenated into the existing advisory
 * stream; `errorCode` (when present) lets the CLI's JSON envelope
 * stamp a stable machine-readable code (e.g. `INVALID_NAME`) instead
 * of falling back to the generic `PLAN_FAILED` classifier.
 */
export interface AssertionExtraction {
  elicited: Record<string, unknown>;
  errors: string[];
  /** Non-blocking advisories — e.g. trailing name tokens that were ignored. */
  advisories: Advisory[];
  /**
   * Machine-readable classifier for the first error in `errors`. Left
   * `undefined` when the failure is a grab-bag of validation errors
   * with no single dominant classifier — callers fall back to the
   * generic `PLAN_FAILED` envelope in that case.
   */
  errorCode?: string;
}
