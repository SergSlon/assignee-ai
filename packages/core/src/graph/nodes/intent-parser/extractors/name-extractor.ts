// ---------------------------------------------------------------------------
// Resource-name extractor (Epic 94 Wave 1 fixer e94.R8 — A-05 + A-06)
// ---------------------------------------------------------------------------
//
// Extracted from `packages/core/src/graph/nodes/intent-parser.ts` by RW7
// (cluster manifest 2026-04-27). See manifest for the full decomposition
// plan; this file owns:
//   - NAME_BOUNDARY_KEYWORDS (module constant)
//   - containsNonAscii (private helper)
//   - parseNameSpan (private helper)
//   - extractResourceName (orchestrator-facing extractor)
//   - resolveNameField (exported; used externally by N5 NAME_REWRITTEN
//     comparator)
//
// Background: the previous extractor used
//   /\b(?:named|called)\s+['"]?([A-Za-z][A-Za-z0-9_-]{0,63})\b/
// which has two silent-data-loss bugs:
//
//   - Non-ASCII characters short-circuit the capture group. Input
//     `named dögfood-ünicode` captures just `d` (the `ö` is not in
//     `[A-Za-z0-9_-]`, so the quantifier ends after the first char).
//     R1's `validateDesiredStateNode` then sees a 1-char string and
//     rejects it with a generic length error instead of the real
//     "non-ASCII character" error the user needs. Worse: if the
//     captured prefix happened to be ≥3 chars, the validator would
//     accept a silently-mangled name.
//
//   - Multi-word names like `named bad bucket name` silently capture
//     only `bad`, discarding the trailing tokens. The plan succeeds
//     with the WRONG bucket name and the user has no signal the tail
//     was dropped.
//
// Fix: capture the full raw span after `named ` / `called ` up to a
// conservative boundary (known directive keyword, punctuation, or
// end-of-intent). Quoted spans preserve internal whitespace. Classify
// the result:
//
//   - Non-ASCII in the leading chunk → push INVALID_NAME error; no
//     `elicited` write so R1's validator does not see a mangled
//     value.
//   - Quoted span honouring spaces → treat the full quoted content
//     as the name (no advisory).
//   - Unquoted single token → write to the name field as before.
//   - Unquoted with trailing tail after a space → write the leading
//     token but also attach a NAME_REMAINDER_IGNORED advisory so the
//     user sees that their tail was discarded.

import { RESOURCE_TYPES } from "../../../../index.js";
import type { Advisory } from "../intent-types.js";
import { containsNonAscii } from "../validators/token-validators.js";
import { inlineNameHint } from "../../advice/inline-name-hint.js";

/**
 * Keywords that follow a name in natural-language AWS intents and
 * signal the name has ended. Used to trim trailing directive clauses
 * ("with versioning", "in us-east-1", "for the web tier") from the
 * raw remainder before we look for a leftover name tail.
 */
const NAME_BOUNDARY_KEYWORDS: ReadonlySet<string> = new Set([
  // Directive prepositions / connectives — these introduce a
  // configuration clause, not additional name tokens.
  "with",
  "for",
  "in",
  "on",
  "using",
  "allowing",
  "allow",
  "that",
  "which",
  "to",
  "from",
  "at",
  "and",
  "plus",
  "but",
  "where",
  "having",
  // Common config adjectives that appear right after a name.
  "encrypted",
  "versioned",
  "versioning",
  "tagged",
]);

/**
 * Parse the raw span after the "named " / "called " keyword into
 * either a quoted name (any chars between matching quotes) or an
 * unquoted leading token plus a trailing tail.
 *
 * Trailing boundary keywords ("with", "in", "for", …) terminate the
 * name so a clause like "named app-logs with versioning" does NOT
 * produce a `with versioning` remainder advisory.
 */
interface ParsedName {
  /** The captured name itself — unquoted, whitespace-preserving if quoted. */
  name: string;
  /** Tail tokens that followed the leading token and were NOT directive keywords. */
  remainder: string;
  /** True when the original form used `"..."` or `'...'`. */
  quoted: boolean;
}

function parseNameSpan(rawSpan: string): ParsedName | null {
  const trimmed = rawSpan.trimStart();
  if (trimmed.length === 0) return null;

  // Quoted form — honour any characters (including spaces) inside the
  // matched quote pair. Unicode rejection still applies at the caller.
  const quoteChar = trimmed[0];
  if (quoteChar === '"' || quoteChar === "'") {
    const end = trimmed.indexOf(quoteChar, 1);
    if (end > 1) {
      return {
        name: trimmed.slice(1, end),
        remainder: "",
        quoted: true,
      };
    }
    // Unterminated quote — fall through to unquoted parsing so we
    // don't silently drop the rest of the intent.
  }

  // Unquoted — the leading token is the first contiguous non-whitespace
  // run. We do NOT strip trailing punctuation at this stage because
  // "named 192.168.1.1" carries internal dots that are part of the
  // name (they need to survive so R1's validator sees the IPv4 shape
  // and rejects it). Sentence-ending punctuation is already excluded
  // by the outer span regex (`[^\n,;.?!]*`) — the leading token here
  // is guaranteed not to end in `.`, `,`, `;`, `?`, or `!`.
  //
  // Subsequent whitespace-delimited tokens form the raw tail; we cut
  // the tail at the first directive-keyword boundary so
  // "named app-logs with versioning" does not carry `with versioning`
  // as a name remainder.
  const match = /^(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return null;
  const leading = match[1]!;
  const tailRaw = (match[2] ?? "").trim();

  let remainderBeforeBoundary = "";
  if (tailRaw.length > 0) {
    const tokens = tailRaw.split(/\s+/);
    const accepted: string[] = [];
    for (const tok of tokens) {
      // Stop copying as soon as a directive keyword appears — the
      // user has transitioned from naming into configuration.
      if (NAME_BOUNDARY_KEYWORDS.has(tok.toLowerCase())) break;
      accepted.push(tok);
    }
    remainderBeforeBoundary = accepted.join(" ").trim();
  }

  return {
    name: leading,
    remainder: remainderBeforeBoundary,
    quoted: false,
  };
}

/**
 * Extracts "named X" / "called X" resource identifier.
 *
 * Epic 94 e94.R8 overhaul:
 *   - Captures multi-word / quoted spans (not just the first ASCII word).
 *   - Rejects unicode names with an explicit `INVALID_NAME` error
 *     surfaced through the standard `[ERROR]+[FIX]` path.
 *   - Emits a `NAME_REMAINDER_IGNORED` advisory when trailing tokens
 *     are dropped so the user knows their tail was ignored.
 */
export function extractResourceName(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  errors: string[],
  advisories: Advisory[],
  errorCodeBox: { code?: string },
): void {
  // Grab the entire span after the "named" / "called" keyword up to
  // a conservative terminator: newline, clause-ending punctuation, or
  // end-of-intent. The span may include whitespace, unicode, and
  // quotes — classification happens in `parseNameSpan` below.
  //
  // Terminators:
  //   - `\n`, `,`, `;`, `?`, `!`  (always end the clause)
  //   - `.` ONLY when it is NOT followed by an alphanumeric
  //     character. `192.168.1.1` keeps its internal dots intact
  //     because each `.` is followed by a digit; but "named
  //     my-bucket. It must be encrypted" ends at the first `.` because
  //     the next char is a space.
  //
  // Using case-insensitive match so "Named", "NAMED", "Called" all
  // trigger the same path.
  const spanRegex = /\b(?:named|called)\s+((?:\.(?=[A-Za-z0-9])|[^\n,;.?!])*)/i;
  const match = spanRegex.exec(intent);
  if (!match) return;

  // Strip a single trailing clause-punctuation run (defensive — the
  // regex above already excludes them at the end, but covers the
  // case where the last `.` was part of a valid compound token
  // followed by end-of-string).
  const rawSpan = (match[1] ?? "").replace(/[.,;?!]+$/, "");
  const parsed = parseNameSpan(rawSpan);
  if (!parsed || parsed.name.length === 0) return;

  // A-05: non-ASCII characters are rejected EVERYWHERE in AWS
  // resource names (S3, Lambda, SQS, IAM, …). Surface an explicit
  // INVALID_NAME error instead of writing a silently-truncated
  // ASCII prefix that R1's validator would misattribute.
  //
  // e96.W2.R7 (A-11) — also stamp the machine-readable
  // `INVALID_NAME` code on the extraction so the CLI's JSON envelope
  // path in plan/orchestrator.ts can propagate it instead of falling
  // back to the generic `PLAN_FAILED` classifier.
  if (containsNonAscii(parsed.name)) {
    errors.push(
      `Invalid resource name "${parsed.name}" — non-ASCII characters are not allowed. AWS resource names (S3 buckets, Lambda functions, SQS queues, IAM roles, …) must be ASCII-only. Rename using letters, digits, and hyphens.`,
    );
    if (errorCodeBox.code === undefined) {
      errorCodeBox.code = "INVALID_NAME";
    }
    return;
  }

  // A-06: unquoted multi-word remainder → emit advisory so the user
  // sees that their tail was dropped. Quoted spans are treated as a
  // single intentional name — no advisory even when they contain
  // whitespace.
  if (!parsed.quoted && parsed.remainder.length > 0) {
    advisories.push({
      code: "NAME_REMAINDER_IGNORED",
      message: `Ignored trailing tokens after the resource name: "${parsed.remainder}". Only "${parsed.name}" was used as the resource identifier.`,
      hint: `Use quotes to include spaces in the name (e.g. named "${parsed.name} ${parsed.remainder}"), or join the words with hyphens (e.g. ${parsed.name}-${parsed.remainder.replace(/\s+/g, "-")}).`,
    });
  }

  // Route the captured name to the correct CFN property. `resolveNameField`
  // returns null for types without a user-settable name — in that case the
  // captured value is silently dropped (no advisory, because there is no
  // name slot to put it in).
  const nameField = resolveNameField(resourceType);
  if (nameField) elicited[nameField] = parsed.name;
}

// ---------------------------------------------------------------------------
// SX-2 / PH1-C-1 — inline-name extractor
// ---------------------------------------------------------------------------
//
// When the user omits the explicit "named X" / "called X" keyword and
// instead writes the name immediately after the resource-type token
// (e.g. "Create an SNS topic genai-events"), the keyword extractor above
// returns empty and the planner falls back to an auto-generated name —
// silently dropping the user's clear intent. SX-2 closes that gap.
//
// For each supported resource type, an inline pattern matches the token
// after the type keyword. The candidate is validated against the
// resource's AWS naming constraint; on success the name is written to
// `elicited[<NameField>]` and an INFO advisory is emitted via the
// helper at `advice/inline-name-hint.ts`.
//
// Inline detection ONLY fires when:
//   - The keyword path above did not already set `elicited[<NameField>]`
//     (so "topic foo called bar" still resolves to "bar").
//   - The candidate token passes the per-resource AWS naming constraint.
//   - The candidate token is not a known boundary keyword (e.g. "with").

/** Per-resource AWS naming constraint check. Returns true when the candidate
 *  conforms to the resource's API constraint. */
function isValidInlineNameForType(
  resourceType: string,
  candidate: string,
): boolean {
  // S3 bucket names — DNS-compliant: lowercase letters, digits, hyphens,
  // periods. Length 3-63. Must start/end with letter or digit.
  if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(candidate);
  }
  // Lambda function names — letters/digits/hyphens/underscores. 1-64.
  if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(candidate);
  }
  // SNS topic + SQS queue + ECS cluster + ECR repo + IAM role + Log group
  // all accept alphanumerics + hyphens (and underscores for some). Use a
  // permissive but bounded check; the CFN API will reject malformed values
  // at apply time.
  if (
    resourceType === RESOURCE_TYPES.SNS_TOPIC ||
    resourceType === RESOURCE_TYPES.SQS_QUEUE ||
    resourceType === RESOURCE_TYPES.DYNAMODB_TABLE ||
    resourceType === RESOURCE_TYPES.ECS_CLUSTER ||
    resourceType === RESOURCE_TYPES.ECR_REPOSITORY ||
    resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP ||
    resourceType === RESOURCE_TYPES.IAM_ROLE
  ) {
    return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(candidate);
  }
  return false;
}

/** Resource-type keyword → resource type identifier mapping. The list maps
 *  intent-text triggers ("topic", "queue", etc.) to the canonical resource
 *  type so the inline regex can produce the correct candidate per intent. */
const INLINE_NAME_KEYWORDS: ReadonlyArray<{
  keyword: string;
  resourceType: string;
}> = [
  { keyword: "topic", resourceType: RESOURCE_TYPES.SNS_TOPIC },
  { keyword: "queue", resourceType: RESOURCE_TYPES.SQS_QUEUE },
  { keyword: "table", resourceType: RESOURCE_TYPES.DYNAMODB_TABLE },
  { keyword: "function", resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION },
  { keyword: "bucket", resourceType: RESOURCE_TYPES.S3_BUCKET },
];

/**
 * Inline-name extraction — runs AFTER `extractResourceName` and only fires
 * when no name was set by the keyword path. Detects patterns like
 * `<keyword> <candidate-token>` (e.g. "topic genai-events") and writes
 * the candidate to the resource's name field on success.
 *
 * Emits an INFO advisory via `inlineNameHint` so the user sees we picked
 * up their intent and how to suppress the hint by using "named".
 */
export function extractInlineName(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  advisories: Advisory[],
): void {
  const nameField = resolveNameField(resourceType);
  if (!nameField) return;
  // Keyword path already wrote a name — explicit wins.
  if (typeof elicited[nameField] === "string") return;

  // Find the type keyword that matches this resource. The intent-parser
  // already fixed `resourceType` upstream; we just need the matching keyword
  // token to anchor the inline regex.
  const config = INLINE_NAME_KEYWORDS.find(
    (e) => e.resourceType === resourceType,
  );
  if (!config) return;

  // Match `<keyword>\s+<candidate>` where candidate is a single
  // hyphen/underscore/dot/alphanumeric run (NO whitespace). Case-insensitive
  // on the keyword, case-sensitive on the candidate so we can apply the
  // S3 lowercase constraint downstream.
  const re = new RegExp(
    String.raw`\b${config.keyword}\s+([A-Za-z0-9][A-Za-z0-9_.-]{0,253})\b`,
    "i",
  );
  const m = re.exec(intent);
  if (!m || !m[1]) return;

  const candidate = m[1];

  // Reject candidates that are themselves boundary keywords — e.g.
  // "topic with high throughput" should NOT extract "with" as the name.
  // Also reject "named" / "called" — those would only appear when the
  // user wrote `<keyword> named X` and the explicit-keyword path is
  // handling that case (so inline must not steal "named" as the name).
  const candidateLower = candidate.toLowerCase();
  if (NAME_BOUNDARY_KEYWORDS.has(candidateLower)) return;
  if (candidateLower === "named" || candidateLower === "called") return;

  // Reject candidates that don't pass the per-resource AWS naming
  // constraint. Falls through to the auto-generator (no user-facing
  // error — the candidate is treated as descriptive text, not a name).
  if (!isValidInlineNameForType(resourceType, candidate)) return;

  // Non-ASCII check (defensive — the regex character class is already
  // ASCII-only, but a future widening of the class should keep this guard).
  if (containsNonAscii(candidate)) return;

  elicited[nameField] = candidate;
  advisories.push(inlineNameHint(candidate, nameField));
}

/**
 * Resolve the CFN property name that carries the user-settable resource
 * name for a given resource type. Returns `null` when the type has no
 * such field (e.g., EC2::Instance uses tags for naming, not a top-level
 * `Name` property).
 *
 * Exported so the plan-stage NAME_REWRITTEN comparator (N5) can
 * resolve the same field without duplicating the switch.
 */
export function resolveNameField(resourceType: string): string | null {
  switch (resourceType) {
    case RESOURCE_TYPES.LAMBDA_FUNCTION:
      return "FunctionName";
    case RESOURCE_TYPES.DYNAMODB_TABLE:
      return "TableName";
    case RESOURCE_TYPES.SNS_TOPIC:
      return "TopicName";
    case RESOURCE_TYPES.SQS_QUEUE:
      return "QueueName";
    case RESOURCE_TYPES.S3_BUCKET:
      return "BucketName";
    case RESOURCE_TYPES.ECS_CLUSTER:
      return "ClusterName";
    case RESOURCE_TYPES.ECR_REPOSITORY:
      return "RepositoryName";
    case RESOURCE_TYPES.LOGS_LOG_GROUP:
      return "LogGroupName";
    case RESOURCE_TYPES.IAM_ROLE:
      return "RoleName";
    default:
      return null;
  }
}
