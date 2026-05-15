/**
 * LLM-fallback compound-pattern classifier.
 *
 * Epic-107 Story 1 — deep fix for PH1-H-1 (whack-a-mole keyword registry).
 *
 * Invoked ONLY when:
 *   1. `PatternRegistry.detect()` returned `null` (keyword miss), AND
 *   2. The intent contains ≥ MIN_INTENT_WORDS words (cheap gate to avoid
 *      burning LLM tokens on trivially short intents like "make sqs").
 *
 * The LLM is shown the full catalogue of known pattern IDs + their
 * descriptions and asked to pick ONE or return "NONE".  The response is
 * Zod-validated; schema-rejection OR low-confidence both fall through to
 * the SX-1 advisory path (no crash, no change to existing semantics).
 *
 * Cost visibility: every call carries
 *   `callsite: "intent-parser/compound-classifier-llm"`
 * so per-call token spend is greppable in the structured-log stream
 * (per `feedback_token_cost_visibility`).
 *
 * CI safety: callers inject a mock `LlmPort`; no real Bedrock call is ever
 * made in the test environment (per `feedback_simulate_ci_no_creds`).
 */

import type { PatternRegistry } from "../../../pattern-templates/registry.js";
import type { LlmPort } from "../../../ports/llm-port.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import {
  CompoundClassifierResponseSchema,
  type CompoundClassifierResponse,
} from "./compound-classifier-llm.schema.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum intent length (word count) below which the LLM fallback is
 * skipped entirely.  Short intents ("make sqs", "create lambda") are
 * already handled by the keyword classifier or the main LLM intent-parser;
 * adding an extra Bedrock call for 1-3 word intents wastes tokens and adds
 * latency for zero benefit.
 *
 * Configurable in tests by passing `minIntentWords` override.
 */
export const DEFAULT_MIN_INTENT_WORDS = 10;

/**
 * Max LLM output tokens for the compound-classifier call.
 * The response is a small JSON object (patternKey + confidence + rationale).
 * 256 tokens is more than sufficient; keeping it tight bounds per-call cost
 * to ~0.05 USD for Sonnet-class models (per the story's cost-surface note).
 */
const MAX_TOKENS = 256;

/** Callsite token used for token-usage attribution and log correlation. */
export const CALLSITE = "intent-parser/compound-classifier-llm" as const;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Result returned by `classifyCompoundViaLlm`.
 *
 * `kind: "match"` — LLM returned a known patternKey with high/medium
 *   confidence. The caller should look it up in the registry.
 * `kind: "no-match"` — LLM returned null, or confidence was low, or the
 *   schema was rejected.  Caller falls through to the SX-1 advisory path.
 * `kind: "skipped"` — Intent too short; LLM was not called.
 */
export type CompoundClassifyResult =
  | { kind: "match"; patternKey: string }
  | { kind: "no-match" }
  | { kind: "skipped" };

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Build the structured prompt for the compound-pattern classifier call.
 * Kept minimal: the catalogue + intent + clear JSON instruction.
 */
function buildClassifierPrompt(
  intent: string,
  patternCatalogue: Array<{ patternId: string; description: string }>,
): string {
  const catalogueLines = patternCatalogue
    .map((p) => `  - "${p.patternId}": ${p.description}`)
    .join("\n");

  return `You are an AWS infrastructure pattern classifier.

Given the user intent below, decide which compound architecture pattern (if any) best matches.

Known compound patterns:
${catalogueLines}

Return JSON with exactly these fields:
  "patternKey": the matching pattern id string from the catalogue above, or null if no pattern fits.
  "confidence": "high", "medium", or "low" — your confidence that the match is correct.
  "rationale": a one-sentence explanation (used for logging, not shown to the user).

Rules:
- Return null for patternKey if the intent describes a single resource with no compound wiring.
- Return null for patternKey if no catalogue pattern closely matches the intent.
- Prefer null over a low-confidence guess — low confidence means the caller falls through to a safe fallback.
- Do NOT invent pattern ids outside the catalogue above.

User intent: "${intent}"`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to classify a compound architecture pattern for `intent` via a
 * structured LLM call when the keyword-registry produced no match.
 *
 * @param intent   - Raw (already sanitised) user intent string.
 * @param registry - The live PatternRegistry (used to build the catalogue
 *                   and to verify the returned patternKey exists).
 * @param llmClient - LlmPort implementation (mocked in CI).
 * @param runId    - Optional LangGraph run ID for log correlation.
 * @param options  - Override constants for testing (minIntentWords).
 */
export async function classifyCompoundViaLlm(
  intent: string,
  registry: PatternRegistry,
  llmClient: LlmPort,
  runId?: string,
  options?: { minIntentWords?: number },
): Promise<CompoundClassifyResult> {
  const minWords = options?.minIntentWords ?? DEFAULT_MIN_INTENT_WORDS;

  // ── Cheap gate: skip LLM for short intents ───────────────────────────────
  const wordCount = intent.trim().split(/\s+/).length;
  if (wordCount < minWords) {
    // No log at info/warn level for this hot-path skip — it fires on every
    // short intent and would flood the log.  Callers see "skipped" in the
    // return and can log at their discretion.
    return { kind: "skipped" };
  }

  // ── Build catalogue from live registry ───────────────────────────────────
  const allPatterns = registry.list();
  const patternCatalogue = allPatterns.map((p) => ({
    patternId: p.patternId,
    // Use description if present on the pattern type, otherwise fall back to
    // a minimal "keywords: X, Y" summary so the prompt is still informative.
    description:
      (p as unknown as { description?: string }).description ??
      `keywords: ${p.keywords.slice(0, 3).join(", ")}`,
  }));

  const prompt = buildClassifierPrompt(intent, patternCatalogue);

  // ── LLM call ─────────────────────────────────────────────────────────────
  const [err, raw] = await llmClient.generateStructured(
    prompt,
    CompoundClassifierResponseSchema,
    {
      maxTokens: MAX_TOKENS,
      callsite: CALLSITE,
      runId,
    },
  );

  if (err) {
    // Schema-rejection or network error — fall through to advisory, no crash.
    log({
      ts: new Date().toISOString(),
      runId: runId ?? "",
      level: "warn",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: {
        callsite: CALLSITE,
        outcome: "llm_error_fallback",
        error: err.message,
      },
    });
    return { kind: "no-match" };
  }

  const result = raw as CompoundClassifierResponse;

  // ── Validate confidence gate ─────────────────────────────────────────────
  if (result.confidence === "low") {
    log({
      ts: new Date().toISOString(),
      runId: runId ?? "",
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: {
        callsite: CALLSITE,
        outcome: "low_confidence_fallback",
        patternKey: result.patternKey,
        rationale: result.rationale,
      },
    });
    return { kind: "no-match" };
  }

  // ── patternKey === null means LLM found no catalogue match ───────────────
  if (result.patternKey === null) {
    log({
      ts: new Date().toISOString(),
      runId: runId ?? "",
      level: "info",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: {
        callsite: CALLSITE,
        outcome: "llm_none",
        confidence: result.confidence,
        rationale: result.rationale,
      },
    });
    return { kind: "no-match" };
  }

  // ── Verify the returned patternKey is actually registered ────────────────
  // The LLM might hallucinate a key that isn't in the live registry.
  if (!registry.has(result.patternKey)) {
    log({
      ts: new Date().toISOString(),
      runId: runId ?? "",
      level: "warn",
      action: LOG_ACTIONS.INTENT_PARSED,
      extras: {
        callsite: CALLSITE,
        outcome: "hallucinated_pattern_key",
        patternKey: result.patternKey,
        confidence: result.confidence,
      },
    });
    return { kind: "no-match" };
  }

  // ── Happy path — valid, registered, high/medium confidence match ─────────
  log({
    ts: new Date().toISOString(),
    runId: runId ?? "",
    level: "info",
    action: LOG_ACTIONS.INTENT_PARSED,
    extras: {
      callsite: CALLSITE,
      outcome: "match",
      patternKey: result.patternKey,
      confidence: result.confidence,
      rationale: result.rationale,
    },
  });
  return { kind: "match", patternKey: result.patternKey };
}
