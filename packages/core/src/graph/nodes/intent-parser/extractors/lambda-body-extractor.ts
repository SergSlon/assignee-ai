/**
 * Lambda body intent extractor.
 *
 * Detects phrases like "returns X" / "responds with X" / "outputs X" /
 * "prints X" / "logs X" in the user intent and writes a generated
 * Node.js handler body to `elicitedOptions.Code.ZipFile`. The compound
 * plan spread at `compound-plan.ts:76-79` then overrides the placeholder
 * `ZipFile` in the pattern's `defaultOptions.Code` with the user-extracted
 * body — closing PR #52's regression that the standalone plugin path
 * already fixed.
 *
 * SX-7 / PH1-D-1 fix. Per Winston compound-pattern memo §1 Defect C, the
 * fix lives in the parser (one extractor) rather than across the 4
 * Lambda compound patterns. Benefits every compound pattern containing
 * a Lambda resource without per-pattern edits.
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
 * Regex capturing the body phrase. Anchored at word boundary, greedy
 * stop at sentence terminator or end of string.
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
 * Compose the handler body string that ships into `Code.ZipFile`.
 *
 * The shape mirrors the placeholder handler in
 * `pattern-templates/patterns/lambda-with-exec-role.ts` — a 200-OK echo
 * with the body literal substituted in. Single-quoted to match the
 * surrounding code's quoting convention and keep the diff small.
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
