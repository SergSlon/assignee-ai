/**
 * Typed-confirmation token logic for single-resource destroy.
 *
 * Wave 2 P1-6 + Wave 4 F4 + Wave 5 F3 hardened:
 *  - case-insensitive match (compared in caller)
 *  - trim whitespace
 *  - strip trailing slashes
 *  - fall back to full ARN when identifier AND ARN tail both collapse
 */

/**
 * Computes the typed-confirmation token for a single-resource destroy.
 *
 * Prefers `identifier` (CloudControl primary identifier, human-readable for
 * most types), falling back to `arn.split(/[/:]/).pop()`, and finally to the
 * full ARN if both collapse to empty after normalization.
 *
 * Matching is performed case-insensitively by the caller.
 */
export function resourceConfirmationToken(resource: {
  identifier?: string;
  arn: string;
}): string {
  // R2-C N1 + P2-R2-5: normalize whitespace AND trailing slashes.
  const normalize = (s: string): string => s.trim().replace(/\/+$/, "").trim();

  const id = normalize(resource.identifier ?? "");
  if (id) return id;

  const arnTail = resource.arn.split(/[/:]/).pop() ?? "";
  const tailNorm = normalize(arnTail);
  if (tailNorm) return tailNorm;

  return resource.arn;
}
