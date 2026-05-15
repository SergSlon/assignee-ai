/**
 * Zod schema for the LLM-fallback compound-pattern classifier response.
 *
 * Epic-107 Story 1 — LLM-fallback compound classifier.
 *
 * The LLM is asked: "given this intent and the catalogue of known compound
 * patterns, which pattern (or NONE) best fits?"  It returns:
 *   - `patternKey`: the matching `patternId` string, or `null` / the literal
 *     string "NONE" when no catalogue pattern fits.
 *   - `confidence`: the model's self-reported confidence level.
 *   - `rationale`: a brief explanation (used for logging only).
 *
 * NONE-normalisation: the `transform` step maps the string `"NONE"` to
 * `null` so callers only need to check `patternKey === null`.
 *
 * Confidence gate: only `"high"` or `"medium"` results are accepted by
 * `classifyCompoundViaLlm`; `"low"` falls through to the SX-1 advisory
 * path just as a schema-rejection would.
 */

import { z } from "zod";

/** The raw Zod schema — validated directly from the LLM structured output. */
export const CompoundClassifierResponseSchema = z.object({
  /** patternId from the registered catalogue, or null / "NONE" when no match. */
  patternKey: z
    .union([z.string(), z.null()])
    .transform((v) => (v === "NONE" ? null : v)),
  /** Model's self-reported confidence — only high/medium results are actioned. */
  confidence: z.enum(["high", "medium", "low"]),
  /** Free-text rationale for logging/debugging. Not surfaced to the user. */
  rationale: z.string(),
});

export type CompoundClassifierResponse = z.infer<
  typeof CompoundClassifierResponseSchema
>;
