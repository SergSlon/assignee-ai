/**
 * Compound pattern-ID exact-match table.
 *
 * Epic 94 Wave 2 fixer e94.N5 — closes finding C-07.
 *
 * When the user types a literal pattern-ID string in their intent —
 * e.g. "Create a static-website pattern" or "serverless-api pattern"
 * — they are explicitly asking for that compound by ID. The regular
 * `defaultPatternRegistry.detect()` keyword-substring matcher does
 * NOT always catch these forms (e.g. "static-website" is hyphenated
 * but the registry keywords use the space-separated form
 * "static website"), so a naive call falls through to the LLM
 * classifier with sometimes unpredictable routing.
 *
 * This fast-path check runs BEFORE the keyword registry: if the
 * user's intent contains one of the six pattern-ID literals
 * (token-bounded, case-insensitive), the intent-parser looks the
 * pattern up directly via `defaultPatternRegistry.get(patternId)`
 * and bypasses the negativeKeywords filter entirely — the user has
 * been explicit.
 *
 * The six supported literals are the six "compound" patterns whose
 * identifier is commonly referenced verbatim in demos, docs, and
 * CLI examples:
 *
 *   - `static-website`       → PatternId.STATIC_WEBSITE
 *   - `serverless-api`       → PatternId.SERVERLESS_API
 *   - `scheduled-lambda`     → PatternId.SCHEDULED_LAMBDA
 *   - `websocket-api`        → PatternId.WEBSOCKET_API
 *   - `efs-with-vpc`         → PatternId.EFS_WITH_VPC
 *   - `lambda-with-exec-role` → PatternId.LAMBDA_WITH_EXEC_ROLE
 *
 * Registered in the order above, which also aligns with
 * longest-match precedence: `lambda-with-exec-role` is registered
 * LAST so a (hypothetical) more specific longer prefix would win
 * first if ever added. In practice all six literals are unique so
 * order is mostly cosmetic.
 */

import { PatternId } from "../pattern-templates/pattern-ids.js";

/**
 * Token-bounded pattern-ID lookup.
 *
 * The map is ordered by literal length (longest first) so that a
 * hypothetical intent containing both `"lambda-with-exec-role"` and
 * `"lambda"` resolves to the longer specific literal.
 */
export const COMPOUND_PATTERN_ID_LITERALS: ReadonlyArray<{
  literal: string;
  patternId: string;
}> = [
  {
    literal: "lambda-with-exec-role",
    patternId: PatternId.LAMBDA_WITH_EXEC_ROLE,
  },
  { literal: "scheduled-lambda", patternId: PatternId.SCHEDULED_LAMBDA },
  { literal: "static-website", patternId: PatternId.STATIC_WEBSITE },
  { literal: "serverless-api", patternId: PatternId.SERVERLESS_API },
  { literal: "websocket-api", patternId: PatternId.WEBSOCKET_API },
  { literal: "efs-with-vpc", patternId: PatternId.EFS_WITH_VPC },
];

/**
 * Resolve a pattern-ID literal in the user intent, if present.
 *
 * Matching rules:
 *   - Case-insensitive.
 *   - Token-bounded: the literal must start at a word boundary
 *     (start of string or non-alphanumeric char) and end at a word
 *     boundary (end of string or non-alphanumeric char). This
 *     prevents `"efs-with-vpc-x"` or `"lambda-with-exec-role-arn"`
 *     from accidentally matching.
 *   - First match wins (iteration in the array above). Longest
 *     literals are placed first so longer-prefix overlaps resolve
 *     to the more specific id.
 *
 * Returns the `PatternId` string constant or `null` if no literal
 * is present in the intent.
 */
export function resolveCompoundPatternIdLiteral(intent: string): string | null {
  const lower = intent.toLowerCase();
  for (const { literal, patternId } of COMPOUND_PATTERN_ID_LITERALS) {
    const idx = lower.indexOf(literal);
    if (idx === -1) continue;
    // Token boundary check — char before literal must not be
    // alphanumeric or `-`, and char after literal must not be
    // alphanumeric or `-`. This keeps `"efs-with-vpc"` from matching
    // inside `"my-efs-with-vpc-module"`.
    const before = idx === 0 ? "" : lower.charAt(idx - 1);
    const after =
      idx + literal.length === lower.length
        ? ""
        : lower.charAt(idx + literal.length);
    const isBoundaryChar = (c: string): boolean =>
      c === "" || !/[a-z0-9-]/.test(c);
    if (isBoundaryChar(before) && isBoundaryChar(after)) {
      return patternId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Singleton-override cues (C-08 + C-09)
// ---------------------------------------------------------------------------

/**
 * Explicit singleton-resource cues that must OVERRIDE the compound
 * pattern matcher. Without these, naive keyword routing would send:
 *
 *   - "Create an EFS mount target"  → `efs-with-vpc` compound (10+
 *     resources) instead of the single `AWS::EFS::MountTarget`.
 *   - "Create an HTTP API Gateway"  → `serverless-api` compound
 *     (8 resources) instead of the single `AWS::ApiGatewayV2::Api`.
 *
 * The user has been explicit about what they want — a single
 * resource, not a full compound. This table pins the override.
 *
 * Epic 94 Wave 2 fixer e94.N5 — closes findings C-08 + C-09.
 */
export const SINGLETON_OVERRIDE_CUES: ReadonlyArray<{
  /** Phrases that, when present, trigger the override. */
  phrases: readonly string[];
  /** Optional disqualifying phrases — if any match, skip this cue. */
  negativePhrases?: readonly string[];
  /** CFN type to force. */
  resourceType: string;
}> = [
  {
    // C-08: "mount target" / "mount-target" / "mounttarget" → singleton
    // EFS::MountTarget.
    phrases: ["mount target", "mount-target", "mount targets", "mounttarget"],
    resourceType: "AWS::EFS::MountTarget",
  },
  {
    // Epic 96 W3.N2/N3 (C-02 MED NEW): bare "EFS file system" /
    // "EFS filesystem" / "EFS FS" → singleton AWS::EFS::FileSystem.
    // Pre-fix the efs-with-vpc compound's keyword list contained both
    // "efs file system" and "efs", so a bare "Create an EFS file
    // system" intent fell through to the compound, spinning up a
    // 10-resource stack (VPC, subnets, RT, associations, NFS SG, mount
    // targets) on top of the single resource the user asked for.
    // Power users who already have a VPC, and beginners just kicking
    // the tyres, both overwhelmingly want the singleton. Users who DO
    // want the full compound have unambiguous phrasing — "with a VPC",
    // "and a VPC", "in a new VPC" — which is captured as the
    // negative-phrase list so the cue does not fire for the compound
    // intent. As part of probe e96.W3.N3, "efs file system" was also
    // removed from the efs-with-vpc compound's keyword list: the bare
    // "efs" keyword is sufficient to detect VPC-qualified compound
    // intents, and removing the redundant "efs file system" keyword
    // eliminates the registry-layer ambiguity.
    //
    // Note "efs" alone is NOT in the phrase list: that's too broad
    // and would catch "efs with vpc" before the negative check.
    // Require the user to name the concrete resource ("EFS file
    // system" / "EFS FS") to claim the singleton route.
    //
    // Downstream: intent-parser calls `extractAssertedValues` against
    // AWS::EFS::FileSystem. FileSystem has no strictly required CFN
    // fields (all properties have server-side defaults) so the plan
    // succeeds with an empty desiredState; user can then add
    // properties through the interactive wizard or --set flags.
    phrases: [
      "efs file system",
      "efs filesystem",
      "efs file-system",
      "efs fs",
      "elastic file system",
      "elastic filesystem",
    ],
    negativePhrases: [
      "with vpc",
      "with a vpc",
      "with new vpc",
      "with a new vpc",
      "and vpc",
      "and a vpc",
      "and new vpc",
      "and a new vpc",
      "in vpc",
      "in a vpc",
      "in new vpc",
      "in a new vpc",
      "plus vpc",
      "plus a vpc",
      "plus new vpc",
      "plus a new vpc",
      // mount-target qualifier — the C-08 cue handles this, but an
      // intent like "EFS file system with mount target in subnet…"
      // should still fall through to the compound path when it names
      // a subnet (which pulls in VPC context). Leave mount-target off
      // the negatives: the C-08 cue runs first in iteration order and
      // steals the routing anyway.
    ],
    resourceType: "AWS::EFS::FileSystem",
  },
  {
    // C-09: "http api gateway" / "http api" → singleton
    // ApiGatewayV2::Api. Disqualify when the user also said
    // "websocket" (that's a different resource family: the websocket
    // pattern owns ProtocolType: WEBSOCKET).
    phrases: ["http api gateway", "http-api-gateway", "http api"],
    negativePhrases: ["websocket"],
    resourceType: "AWS::ApiGatewayV2::Api",
  },
];

/**
 * Resolve an explicit singleton override for the user intent, if
 * any. Returns the forced CFN resource type, or `null` if no
 * singleton cue matched.
 *
 * Match rules:
 *   - Case-insensitive substring.
 *   - If ANY `negativePhrases` substring is present, the cue is
 *     skipped.
 *   - First match wins (iteration order in
 *     {@link SINGLETON_OVERRIDE_CUES}).
 */
export function resolveSingletonOverride(intent: string): string | null {
  const lower = intent.toLowerCase();
  for (const cue of SINGLETON_OVERRIDE_CUES) {
    const positiveHit = cue.phrases.some((p) => lower.includes(p));
    if (!positiveHit) continue;
    const negativeHit =
      cue.negativePhrases?.some((p) => lower.includes(p)) ?? false;
    if (negativeHit) continue;
    return cue.resourceType;
  }
  return null;
}
