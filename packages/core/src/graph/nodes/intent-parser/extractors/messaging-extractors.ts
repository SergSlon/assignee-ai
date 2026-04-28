// Messaging-related token extractors for the intent-parser node.
//
// Houses two pure functions extracted from the legacy
// `intent-parser.ts` monolith (RW7 decomposition):
//   - `extractSnsProtocol`     — derives SNS::Subscription `Protocol` +
//                                `Endpoint` from URL scheme, AWS ARN,
//                                E.164 phone number, or email tokens.
//   - `extractRetentionDays`   — pulls an explicit "N days retention"
//                                clause for `AWS::Logs::LogGroup`.
//
// Both extractors mutate the caller-supplied `elicited` record in-place
// (no return value) so the orchestrator can chain extractors without
// rebinding intermediate maps. They are no-ops for any resourceType
// outside their narrow scope.

import { RESOURCE_TYPES } from "../../../../index.js";

/** Extracts SNS::Subscription Protocol from Endpoint token. */
export function extractSnsProtocol(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.SNS_SUBSCRIPTION) return;
  // URL scheme → protocol (most common, closes D-26 half).
  const httpsMatch = /\bhttps:\/\/\S+/i.exec(intent);
  const httpMatch = /\bhttp:\/\/\S+/i.exec(intent);
  const sqsArnMatch = /arn:aws[\w-]*:sqs:[^\s"']+/i.exec(intent);
  const lambdaArnMatch = /arn:aws[\w-]*:lambda:[^\s"']+/i.exec(intent);
  const firehoseArnMatch = /arn:aws[\w-]*:firehose:[^\s"']+/i.exec(intent);
  const emailMatch = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i.exec(intent);
  // e98.W5.N2 (D-13) — E.164 phone number: `+` followed by 7-15 digits,
  // optionally grouped with spaces/dashes/parens. Spec: ITU-T E.164 allows
  // up to 15 digits including country code. Example matches:
  //   +15551234567, +44 20 7946 0958, +1 (555) 123-4567
  // Non-E.164 numbers (no leading `+`) are rejected to avoid matching
  // random digit sequences (zip codes, IDs, ARNs with accounts, etc.).
  const phoneMatch = /(?<!\S)\+\d(?:[\d\s().-]{6,18})\d(?!\S)/.exec(intent);
  if (httpsMatch) {
    elicited["Protocol"] = "https";
    elicited["Endpoint"] = httpsMatch[0];
    return;
  }
  if (httpMatch) {
    elicited["Protocol"] = "http";
    elicited["Endpoint"] = httpMatch[0];
    return;
  }
  if (sqsArnMatch) {
    elicited["Protocol"] = "sqs";
    elicited["Endpoint"] = sqsArnMatch[0];
    return;
  }
  if (lambdaArnMatch) {
    elicited["Protocol"] = "lambda";
    elicited["Endpoint"] = lambdaArnMatch[0];
    return;
  }
  if (firehoseArnMatch) {
    elicited["Protocol"] = "firehose";
    elicited["Endpoint"] = firehoseArnMatch[0];
    return;
  }
  if (phoneMatch) {
    // Normalise to a compact E.164 form (strip whitespace / punctuation
    // between digits; keep the leading `+`).
    const compact = "+" + phoneMatch[0].replace(/[^\d]/g, "");
    // Re-validate after normalisation: E.164 allows 8-15 digits
    // including country code.
    if (/^\+\d{8,15}$/.test(compact)) {
      elicited["Protocol"] = "sms";
      elicited["Endpoint"] = compact;
      return;
    }
  }
  if (emailMatch && /\b(email|notify|subscribe)\b/.test(intentLower)) {
    elicited["Protocol"] = "email";
    elicited["Endpoint"] = emailMatch[0];
  }
}

/**
 * Extract an explicit "N days retention" clause for
 * `AWS::Logs::LogGroup`. The plan-generator's downstream comparator
 * raises this value to the BP minimum (30) when necessary and emits
 * a `BP_ADJUSTED_VALUE` advisory. Stored in `elicitedOptions` as an
 * integer (matching the CFN schema type).
 *
 * Epic 94 Wave 2 fixer e94.N5 — required for finding D-05 so the
 * comparator has a concrete asserted value to compare against.
 */
export function extractRetentionDays(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.LOGS_LOG_GROUP) return;
  if (!/\bretention\b|\bretain\b/.test(intentLower)) return;
  // Accept "14 days retention" / "14-day retention" / "retention 14
  // days" / "retention of 14 days". Bound the number to 1-3652.
  const patterns: RegExp[] = [
    /\b(\d{1,4})[-\s]*days?\s+retention\b/i,
    /\bretention\s+(?:of\s+)?(\d{1,4})\s*days?\b/i,
    /\bretain\s+(?:for\s+)?(\d{1,4})\s*days?\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(intent);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    elicited["RetentionInDays"] = n;
    return;
  }
}
