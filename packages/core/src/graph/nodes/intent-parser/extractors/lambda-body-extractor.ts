/**
 * Lambda body intent extractor.
 *
 * Detects two patterns in the user intent and writes a generated
 * Node.js handler body to `elicitedOptions.Code.ZipFile`:
 *
 *   1. `body 'X'` / `body "X"` / `body \`X\`` — quoted body literal.
 *      The quoted content is treated as the FULL handler body (option A
 *      per Mary PH5-5-A recommendation). Emits:
 *        exports.handler = async (event) => { <captured-body> };
 *
 *   2. Verb forms: "returns X" / "responds with X" / "outputs X" /
 *      "prints X" / "logs X" (unquoted). Emits the static 200-OK
 *      envelope with the literal substituted in (existing behaviour,
 *      preserved for backwards compatibility with unquoted intents).
 *
 * The compound plan spread at `compound-plan.ts:76-79` then overrides
 * the placeholder `ZipFile` in the pattern's `defaultOptions.Code` with
 * the user-extracted body — closing PR #52's regression that the
 * standalone plugin path already fixed.
 *
 * SX-7 / PH1-D-1 fix. Per Winston compound-pattern memo §1 Defect C,
 * the fix lives in the parser (one extractor) rather than across the 4
 * Lambda compound patterns. Benefits every compound pattern containing
 * a Lambda resource without per-pattern edits.
 *
 * EPIC-106-2 / PH5-5-A fix:
 *   - New QUOTED_BODY regex uses backreference (\1) so the closing
 *     quote cannot leak into the captured token.
 *   - Quoted body literal is now the full handler body (option A),
 *     NOT a response-property fragment of a static envelope.
 *
 * Populated fields in `elicited` (when intent matches):
 *   - `Code`              = { ZipFile: <handler source string> }
 *
 * Only fires when:
 *   - resourceType is `AWS::Lambda::Function` (standalone lambda or any
 *     of lambda-with-exec-role / serverless-api / scheduled-lambda /
 *     websocket-api compounds — all surface LAMBDA_FUNCTION as primary), OR
 *   - resourceType is `AWS::SQS::Queue` AND the intent mentions
 *     `"lambda"` (message-processing compound — its primary resource type
 *     is SQS_QUEUE per `patternPrimaryResourceType`, but the user is
 *     describing a Lambda body).
 */

import { RESOURCE_TYPES } from "@/index.js";

/**
 * Regex capturing a quoted body clause: `body 'X'` / `body "X"` / `body \`X\``.
 *
 * Group 1: the opening quote character (' " `)
 * Group 2: the content between the matched quote pair (non-greedy, no
 *           closing-quote leak because the negative lookahead `(?!\1)`
 *           stops before the matching close).
 *
 * EPIC-106-2 fix: the backreference \1 in the closing position guarantees
 * the same character closes as opened, preventing the stray trailing-quote
 * artifact seen in PH5-5-A where `event'` was captured instead of
 * `return event`.
 */
const QUOTED_BODY = /\bbody\s+(['"`])((?:(?!\1)[\s\S])*)\1/i;

/**
 * Regex capturing the verb-form body phrase (unquoted).
 * Anchored at word boundary, non-greedy stop at sentence terminator or
 * end of string.
 *
 * Verb forms:
 *   - returns / return
 *   - responds with / respond with
 *   - outputs / output
 *   - prints / print
 *   - logs / log
 */
const BODY_PHRASE = new RegExp(
  String.raw`\b(?:returns?|responds?\s+with|outputs?|prints?|logs?)\s+(.+?)(?:[.;]|$)`,
  "i",
);

/**
 * Build the handler source for a QUOTED body literal (option A).
 *
 * The quoted content is treated as the full handler body — whatever the
 * user typed between the quotes IS the body of the async handler. This
 * matches user intent literally: "body 'return event'" → the handler
 * returns the event, not a static envelope.
 *
 * BEHAVIOUR CHANGE (EPIC-106-2): previously, quoted bodies were wedged
 * into the `body:` field of a static 200-OK envelope. The new shape
 * is the full handler body.
 */
function buildHandlerFromQuotedBody(body: string): string {
  return `exports.handler = async (event) => { ${body} };`;
}

/**
 * Build the handler source for an UNQUOTED verb-form body literal.
 *
 * Preserves existing behaviour: the captured literal is placed in the
 * `body:` field of a 200-OK response envelope. Single-quoted to match
 * the surrounding code's quoting convention.
 */
function buildHandler(bodyLiteral: string): string {
  // Escape single quotes in the body literal so the emitted JS stays valid.
  const safe = bodyLiteral.replace(/'/g, "\\'");
  return `exports.handler = async (event) => ({ statusCode: 200, body: '${safe}' });`;
}

/**
 * Extracts a Lambda body description from the user intent and writes the
 * resulting handler source to `elicited.Code.ZipFile`.
 *
 * Silently returns when no match — the pattern's placeholder ZipFile
 * applies (existing behaviour for plain "Create a Lambda" intents).
 *
 * Does NOT fire when the resource is unrelated to Lambda (e.g. an
 * `AWS::S3::Bucket` intent that happens to say "returns").
 */
export function extractLambdaBody(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  // Gate on Lambda-related resource type. Per `patternPrimaryResourceType`
  // in `../index.ts`, 4 of the 5 Lambda-bearing compound patterns surface
  // `LAMBDA_FUNCTION` as their primary resource type, but
  // `message-processing` surfaces `SQS_QUEUE` (the SQS queue is the
  // "name-bearing primary" for that compound). Accept both:
  //   - LAMBDA_FUNCTION unconditionally (standalone + 4 compounds)
  //   - SQS_QUEUE when the intent text mentions "lambda" (message-processing)
  const intentLower = intent.toLowerCase();
  const isLambdaContext =
    resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION ||
    (resourceType === RESOURCE_TYPES.SQS_QUEUE &&
      intentLower.includes("lambda"));
  if (!isLambdaContext) return;

  // Priority 1: quoted body clause — `body 'X'` / `body "X"` / `body \`X\``.
  // The quoted content is treated as the full handler body (option A).
  // EPIC-106-2 / PH5-5-A: this path supersedes the static-envelope shape
  // for quoted-body intents.
  const quotedMatch = intent.match(QUOTED_BODY);
  if (quotedMatch && quotedMatch[2] !== undefined) {
    const quotedBody = quotedMatch[2].trim();
    if (quotedBody.length > 0 && /\w/.test(quotedBody)) {
      const existingCode =
        (elicited["Code"] as Record<string, unknown> | undefined) ?? {};
      elicited["Code"] = {
        ...existingCode,
        ZipFile: buildHandlerFromQuotedBody(quotedBody),
      };
      return;
    }
  }

  // Priority 2: verb-form body phrase (unquoted) — existing behaviour.
  const match = intent.match(BODY_PHRASE);
  if (!match || !match[1]) return;

  const bodyLiteral = match[1].trim();
  if (bodyLiteral.length === 0) return;
  // Require at least one alphanumeric character — guards against captures
  // that are pure punctuation (e.g. "returns ." → captured "." after trim).
  if (!/\w/.test(bodyLiteral)) return;

  // Preserve any user-supplied Code keys (e.g. Handler override) — merge
  // the ZipFile into the existing Code object rather than replacing it.
  const existingCode =
    (elicited["Code"] as Record<string, unknown> | undefined) ?? {};
  elicited["Code"] = {
    ...existingCode,
    ZipFile: buildHandler(bodyLiteral),
  };
}
