// Messaging-related token extractors for the intent-parser node.
//
// Houses two pure functions extracted from the legacy `intent-parser.ts`
// monolith (RW7 decomposition):
//   - `extractSnsProtocol` — derives SNS::Subscription `Protocol` +
//                            `Endpoint` from URL scheme, AWS ARN,
//                            E.164 phone number, or email tokens.
//   - `extractEmailForSnsCompound` — extracts email into `Endpoint` for the
//                            sns-with-email-subscription compound pattern.
//                            Runs on the SNS_TOPIC primary slot so the email
//                            survives `filterElicitedForSlot` into the
//                            SNS_SUBSCRIPTION slot (Endpoint is scoped to
//                            SNS_SUBSCRIPTION in NAME_FIELD_TO_RESOURCE_TYPE).
//
// The extractor mutates the caller-supplied `elicited` record in-place
// (no return value) so the orchestrator can chain extractors without
// rebinding intermediate maps. It is a no-op for any resourceType
// outside its narrow scope.

import { RESOURCE_TYPES } from "../../../../index.js";
import { extractAllEmails } from "./email-extractor.js";
import type { Advisory } from "../intent-types.js";

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
 * CP-2: extract email address for the sns-with-email-subscription compound.
 *
 * Called when the primary resource type is SNS_TOPIC (i.e. the compound
 * pattern matched). Looks for email-subscription phrasing and extracts
 * the email into `elicited.Endpoint`.
 *
 * Variation D decision: when multiple emails are present, emit only the
 * FIRST valid email and add an advisory for each additional address.
 * Rationale: AWS::SNS::Subscription is a 1:1 resource; provisioning
 * multiple subscriptions from one intent requires the user to run
 * `assignee plan` again for each additional subscriber, which is the
 * clearer UX compared to silently spawning N resources.
 *
 * If the intent has email-subscription phrasing but the email token is
 * invalid, add an advisory and DO NOT set Endpoint — the compound
 * plan will still create the bare SNS::Topic without a Subscription.
 */
export function extractEmailForSnsCompound(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  advisories: Advisory[],
): void {
  if (resourceType !== RESOURCE_TYPES.SNS_TOPIC) return;
  // Only fire when the intent carries email-subscription phrasing.
  const hasEmailPhrase =
    intentLower.includes("with email subscription") ||
    intentLower.includes("with subscriber") ||
    intentLower.includes("email subscription to") ||
    intentLower.includes("subscribe") ||
    (intentLower.includes("sns") && intentLower.includes("email"));
  if (!hasEmailPhrase) return;

  const allEmails = extractAllEmails(intent);
  if (allEmails.length === 0) {
    // Try to extract the raw token that the user intended as an email address.
    // First check for a partial @ token (has @ but fails validation),
    // then fall back to the word following "subscription to" / "subscriber" / "email to".
    const atTokenMatch = /[\w.+-]+@[\w-]+/.exec(intent);
    const afterKeywordMatch =
      /(?:subscription to|subscriber|email to)\s+(\S+)/i.exec(intent);
    const badToken = atTokenMatch?.[0] ?? afterKeywordMatch?.[1] ?? null;
    if (badToken) {
      advisories.push({
        code: "SNS_INVALID_EMAIL",
        message: `Email '${badToken}' invalid — Subscription not added.`,
        hint: "Provide a valid email address (e.g. alice@example.com) to create an SNS email subscription.",
      });
    }
    return;
  }

  const primary = allEmails[0];
  elicited["Endpoint"] = primary;

  // Variation D: advise about extra addresses that are NOT provisioned.
  // AWS::SNS::Subscription is 1:1; run `assignee plan` again per extra subscriber.
  for (const extra of allEmails.slice(1)) {
    advisories.push({
      code: "SNS_EXTRA_SUBSCRIBER",
      message: `Additional email '${extra}' not provisioned — only the first subscriber '${primary}' was added.`,
      hint: `Run 'assignee plan "SNS topic with email subscription to ${extra}"' to add more subscriptions.`,
    });
  }
}
