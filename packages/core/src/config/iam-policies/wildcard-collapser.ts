/**
 * Safe-wildcard collapser for managed-policy byte compression.
 *
 * Wave 19 Bug #6 follow-up: AWS IAM managed policies have a hard 6144-byte
 * size limit. As assignee.ai grew to 25+ supported resource types, the
 * generated operator policy started exceeding that limit if we list every
 * action literally — even though `iam-actions.ts` (source of truth) keeps
 * each action explicit for documentation and security review.
 *
 * This collapser replaces N+ actions sharing a `service:Verb` prefix with
 * a single `service:Verb*` wildcard when the wildcard is **safe**:
 *
 *   - The wildcard set is a known read-only / metadata operation prefix
 *     (Describe, Get, List) so the wildcard does not silently grant more
 *     write capabilities than the granular set.
 *   - The collapsed set replaces 3+ actions (otherwise the collapse saves
 *     fewer bytes than the additional review burden of a wildcard).
 *
 * The output is byte-stable: same input → same output, no nondeterministic
 * ordering. Sorting + dedup happens after the collapse so the final policy
 * diff is review-friendly.
 *
 * If the collapser ever needs to handle a write-side prefix (Create*,
 * Delete*, Modify*, Put*) that's a security review threshold and should
 * be added explicitly to SAFE_WILDCARD_PREFIXES below, NOT inferred from
 * the action shape.
 *
 * Split out of `iam-policies.ts` for SRP.
 */

const SAFE_WILDCARD_PREFIXES: ReadonlyArray<string> = [
  "Describe",
  "Get",
  "List",
];

export function collapseToWildcards(actions: readonly string[]): string[] {
  // Group actions by `service:Verb` prefix where `Verb` is one of the
  // safe-wildcard prefixes. Anything that doesn't match any safe prefix
  // is preserved literally.
  const byPrefix = new Map<string, string[]>();
  const literal: string[] = [];

  for (const action of actions) {
    const colonIdx = action.indexOf(":");
    if (colonIdx === -1) {
      literal.push(action);
      continue;
    }
    const service = action.slice(0, colonIdx);
    const verb = action.slice(colonIdx + 1);
    const matchedPrefix = SAFE_WILDCARD_PREFIXES.find((p) =>
      verb.startsWith(p),
    );
    if (!matchedPrefix) {
      literal.push(action);
      continue;
    }
    const groupKey = `${service}:${matchedPrefix}`;
    if (!byPrefix.has(groupKey)) byPrefix.set(groupKey, []);
    byPrefix.get(groupKey)!.push(action);
  }

  const collapsed: string[] = [];
  for (const [groupKey, members] of byPrefix) {
    // Only collapse when 3+ actions share the prefix — otherwise the
    // wildcard is more permissive than the granular set without saving
    // meaningful bytes.
    if (members.length >= 3) {
      collapsed.push(`${groupKey}*`);
    } else {
      literal.push(...members);
    }
  }

  return [...new Set([...literal, ...collapsed])].sort();
}
