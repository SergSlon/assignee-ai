/**
 * Pure email-address extractor for SNS Subscription intent parsing.
 *
 * Uses a conservative regex that matches valid email shapes without
 * relying on a full RFC-5321 parser. The regex intentionally excludes
 * IP-literal domains and quoted local-parts — both are vanishingly rare
 * in real SNS subscriber addresses and would increase false-positive
 * risk for lookalike tokens.
 *
 * Well-formed validation rules applied after the regex match:
 *   - local-part must be ≥1 character
 *   - domain must contain at least one dot
 *   - TLD must be ≥2 characters
 *   - no consecutive dots anywhere
 *   - does not start or end with a dot in local-part or domain label
 */

const EMAIL_REGEX = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

/**
 * Extract the first valid email address from an intent string.
 *
 * Returns `null` if no well-formed email is found (falls through to
 * bare SNS path + advisory in the caller).
 */
export function extractEmail(intent: string): string | null {
  const matches = intent.match(EMAIL_REGEX);
  if (!matches) return null;
  const candidate = matches[0];
  return isWellFormedEmail(candidate) ? candidate : null;
}

/**
 * Extract ALL valid email addresses from an intent string.
 *
 * Used for Variation D (multiple-email) handling — caller decides
 * whether to emit multiple Subscription resources or pick the first
 * and advise about the rest.
 */
export function extractAllEmails(intent: string): string[] {
  const matches = intent.match(EMAIL_REGEX);
  if (!matches) return [];
  return matches.filter(isWellFormedEmail);
}

/**
 * Validate that a regex-matched token is a well-formed email address.
 *
 * The regex already guarantees basic structure; this function adds the
 * semantic checks that the regex cannot express:
 *   - local-part must not start or end with a dot
 *   - domain labels must not start or end with a hyphen
 *   - TLD must be at least 2 characters
 *   - no consecutive dots anywhere in the address
 */
export function isWellFormedEmail(candidate: string): boolean {
  const atIdx = candidate.indexOf("@");
  if (atIdx < 1) return false;

  const local = candidate.slice(0, atIdx);
  const domain = candidate.slice(atIdx + 1);

  if (!local || !domain) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (domain.startsWith(".") || domain.endsWith(".")) return false;
  if (candidate.includes("..")) return false;

  const domainParts = domain.split(".");
  if (domainParts.length < 2) return false;
  const tld = domainParts[domainParts.length - 1] ?? "";
  if (tld.length < 2) return false;

  for (const label of domainParts) {
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }

  return true;
}
