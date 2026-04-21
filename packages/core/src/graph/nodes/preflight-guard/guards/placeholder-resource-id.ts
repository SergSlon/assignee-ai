/**
 * Guard: reject LLM-hallucinated placeholder EC2-style resource IDs in
 * desiredState (Epic 92 findings B-06, B-08 EC2-ID half, C-14).
 *
 * Complements the sibling `placeholder-arn.ts` guard, which only
 * targeted ARN-shaped values. LLMs frequently invent EC2 reference IDs
 * like `vpc-0abc1234def567890`, `subnet-12345678`, `rtb-abc12345`,
 * `sg-0123456789abcdef0`, `igw-0abc1234def567890` — none of which are
 * real in the operator's account. These values slip through preflight
 * until AWS rejects them on apply (`InvalidParameterValue`), or worse,
 * coincidentally match an unrelated real resource in another account.
 *
 * Detection strategy — intentionally conservative to minimise false
 * positives against legitimate customer resource IDs:
 *
 *   - Only flag IDs whose suffix matches the SPECIFIC placeholder
 *     literals the LLM re-emits across samples (`12345678`,
 *     `87654321`, `abc12345`, `def67890`, `0abc1234def567890`) or an
 *     all-zero / all-"0a" pattern of 8+ chars (`00000000`,
 *     `0000000000000000`, `0a0a0a0a`).
 *   - Real AWS IDs are hex-randomised so a real `vpc-0a1b2c3d4e5f67890`
 *     will NOT match the strict placeholder set. The guard errs on
 *     the side of letting real values through; the preflight chain
 *     later hits `ec2:DescribeVpcs` for VPCs (see `vpc-existence.ts`)
 *     to catch non-matching-but-plausible IDs.
 *
 * The guard walks desiredState recursively (depth 32, same as
 * `placeholder-arn.ts`) so nested arrays like
 * `SecurityGroupIds: ["sg-12345678", ...]` are reached.
 */
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult } from "../types.js";

const PLACEHOLDER_RESOURCE_ID_WALK_MAX_DEPTH = 32;

/**
 * Resource-ID prefixes the guard inspects. Deliberately narrow —
 * adding one here means we claim the LLM routinely hallucinates IDs
 * for that resource family.
 *
 * Exported for unit tests and potential reuse by sanitisers.
 */
export const PLACEHOLDER_RESOURCE_ID_PREFIXES = [
  "vpc",
  "subnet",
  "rtb",
  "igw",
  "sg",
  "nat",
  "eni",
  "eip",
  "i",
] as const;

/**
 * Regex matching an EC2-style resource ID whose suffix is one of the
 * canonical LLM hallucination placeholders. Case-insensitive (AWS IDs
 * are lower-case, but we shrug tolerantly at accidental upper-case).
 *
 * The trailing `$` and leading `^` anchor to the ENTIRE string so
 * embedded substrings (e.g. `"arn:aws:ec2:...:vpc/vpc-12345678"`) do
 * not match here — ARN-shaped values belong to `placeholder-arn.ts`.
 *
 * Suffix alternatives (in priority order):
 *   - `0abc1234def567890`              — Epic 92 finding sample
 *   - `0123456789abcdef0`              — Epic 92 finding sample (B-08)
 *   - `12345678` / `87654321`          — docs-example shorthand
 *   - `abc12345` / `def67890`          — docs-example shorthand
 *   - `[0a]{8,}`                       — all-zero / all-"0a" stubs
 */
export const PLACEHOLDER_RESOURCE_ID_REGEX = new RegExp(
  `^(${PLACEHOLDER_RESOURCE_ID_PREFIXES.join("|")})-(` +
    [
      "0abc1234def567890",
      "0123456789abcdef0",
      "12345678",
      "87654321",
      "abc12345",
      "def67890",
      "[0a]{8,}",
    ].join("|") +
    ")$",
  "i",
);

export function isPlaceholderResourceId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return PLACEHOLDER_RESOURCE_ID_REGEX.test(value);
}

export interface PlaceholderResourceIdHit {
  readonly field: string;
  readonly value: string;
}

export function detectPlaceholderResourceId(
  desiredState: Record<string, unknown>,
): PlaceholderResourceIdHit | undefined {
  function walk(
    value: unknown,
    path: string,
    depth: number,
  ): PlaceholderResourceIdHit | undefined {
    if (depth > PLACEHOLDER_RESOURCE_ID_WALK_MAX_DEPTH) return undefined;
    if (typeof value === "string") {
      if (isPlaceholderResourceId(value)) {
        return { field: path, value };
      }
      return undefined;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = walk(value[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const hit = walk(v, path ? `${path}.${k}` : k, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  return walk(desiredState, "", 0);
}

export const placeholderResourceIdGuard: PreflightGuard = {
  id: "placeholder-resource-id",
  async run(ctx: GuardContext): Promise<GuardResult> {
    const hit = detectPlaceholderResourceId(ctx.desiredState);
    if (!hit) return passResult;
    return failResult(
      `Field "${hit.field}" contains a placeholder resource ID ` +
        `(${hit.value}). EC2-style IDs like this are AWS docs examples, ` +
        `not real resources in your account. Either:\n` +
        `  1. Provide a real ID from your account ` +
        `(e.g. \`aws ec2 describe-vpcs --query 'Vpcs[].VpcId'\`).\n` +
        `  2. Override with --set ${hit.field}=<real-id>.\n` +
        `  3. Omit the field and let the provisioner derive it from ` +
        `a compound pattern (vpc-networking, serverless-api) that ` +
        `creates the prerequisite resources.`,
    );
  },
};
