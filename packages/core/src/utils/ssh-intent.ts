/**
 * Shared SSH-bundle intent matcher.
 *
 * Pre-demo audit (2026-05-05) H2: five separate call sites previously
 * each used a bare `/\bssh\b/i` regex to gate the SSH bundle:
 *
 *   - `graph/nodes/resource-provisioner/ssh-iam.ts` (Phase-2 pre-hook)
 *   - `graph/nodes/plan-generator/ssh-windows-guard.ts` (Windows-AMI guard)
 *   - `graph/nodes/plan-generator/compound-helpers.ts` (compound EC2 path)
 *   - `graph/nodes/plan-generator/llm-plan/resource-post-process.ts`
 *     (single-resource LLM EC2 path)
 *   - `graph/nodes/bp-evaluator/compound-suppressor.ts` (BP-EC2-004 suppression)
 *
 * The bare regex matched substrings on phrases like
 * "Create EC2 without SSH", "EC2 with no SSH access", "disable SSH on EC2",
 * "remove SSH" — so the bundle auto-attached a keypair / IAM profile / SG
 * rule on intents that explicitly NEGATED the SSH ask. Audience-visible
 * UX bug for any improvised demo input. Converging on this helper keeps
 * the negation semantics in one place; future call sites use the same
 * gate.
 *
 * Semantics:
 *   - Positive `\bssh\b` (case-insensitive) match is the necessary
 *     precondition.
 *   - Common English negation phrasings within a small connective window
 *     before "ssh" short-circuit to false: "without ssh", "no ssh",
 *     "not ... ssh", "disable[d] ssh", "remove[d] ssh", "drop ssh",
 *     "skip ssh", "exclude[d] ssh", and the suffix forms "ssh disabled"
 *     and "ssh off".
 *   - Optional connective words "any" / "the" between the negation and
 *     "ssh" are tolerated ("no any ssh", "remove the ssh access").
 *   - Unrelated `ssh` mentions in larger sentences still fire the
 *     bundle: "I want EC2 with SSH and TLS" → true (the negation regexes
 *     don't match).
 *
 * SRP: this module changes only when the SSH-intent gate semantics
 * change. No I/O. Pure string predicate.
 */

/**
 * Negation patterns checked AFTER the positive `\bssh\b` precondition.
 * Each pattern is a self-contained regex anchored on word boundaries so
 * partial matches inside larger words ("disabled-foo-ssh-bar") are
 * avoided. Order does not matter — `Array.some` short-circuits on the
 * first match.
 *
 * Connective tolerance: the inner `(?:any\s+|the\s+|all\s+)?` group lets
 * "no any ssh", "remove the ssh access", "exclude all ssh ports" still
 * register as negations.
 */
const SSH_NEGATIONS: readonly RegExp[] = [
  /\bwithout\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bno\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bnot\s+\S+(?:\s+\S+){0,2}\s+ssh\b/i,
  /\bdisabled?\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bdisabling\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bdrop\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bremoved?\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bremoving\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bexcluded?\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bexcluding\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bskip\s+(?:any\s+|the\s+|all\s+)?ssh\b/i,
  /\bssh\s+(?:is\s+)?disabled\b/i,
  /\bssh\s+off\b/i,
];

/**
 * Whether the user's intent string asks for the SSH bundle (positive
 * SSH ask, no English-style negation in close proximity). See module
 * doc comment for the full rule set and rationale.
 */
export function isSshIntent(userIntent: string | undefined): boolean {
  if (!userIntent) return false;
  if (!/\bssh\b/i.test(userIntent)) return false;
  return !SSH_NEGATIONS.some((re) => re.test(userIntent));
}
