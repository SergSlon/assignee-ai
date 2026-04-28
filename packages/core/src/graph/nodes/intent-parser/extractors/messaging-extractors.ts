// Messaging-related token extractors for the intent-parser node.
//
// Houses one pure function extracted from the legacy `intent-parser.ts`
// monolith (RW7 decomposition):
//   - `extractSnsProtocol` — derives SNS::Subscription `Protocol` +
//                            `Endpoint` from URL scheme, AWS ARN,
//                            E.164 phone number, or email tokens.
//
// The extractor mutates the caller-supplied `elicited` record in-place
// (no return value) so the orchestrator can chain extractors without
// rebinding intermediate maps. It is a no-op for any resourceType
// outside its narrow scope.

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
