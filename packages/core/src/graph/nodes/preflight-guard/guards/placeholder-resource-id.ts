/**
 * Guard: reject LLM-hallucinated placeholder EC2-style resource IDs in
 * desiredState (Epic 92 findings B-06, B-08 EC2-ID half, C-14;
 * Epic 94 N6 angle-bracket templates; Epic 96 W3.N1 prose-scope).
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
 *   - e96.W3.N1 — prose-scope: prose-ish fields (`Description`, `Name`,
 *     `Comment`, tag `Value`) are scanned for the same placeholder
 *     token embedded WITHIN the string (whole-word bracketed by
 *     whitespace/punctuation). F-002 found that the LLM sometimes
 *     emits `"Public subnet (subnet-<hex>)"` in a Description; the
 *     whole-string regex used by ID-shaped fields skipped those
 *     entirely, so CloudControl ate the prose verbatim and the plan
 *     shipped with a hallucinated token in the generated tags.
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
 *   - `<…>`                            — Epic 94 finding B-04 angle-bracket
 *                                        template tokens (`subnet-<hex>`,
 *                                        `vpc-<id>`, `sg-<YOUR-ID>` etc.)
 */
const PLACEHOLDER_RESOURCE_ID_SUFFIX_GROUP =
  "(" +
  [
    "0abc1234def567890",
    "0123456789abcdef0",
    "12345678",
    "87654321",
    "abc12345",
    "def67890",
    "[0a]{8,}",
    // Angle-bracket template token: any `<...>` wrapper, content
    // non-greedy so `subnet-<hex>`, `vpc-<id>`, `sg-<YOUR-ID>`,
    // `i-<instance-id>` all match while an honest literal like
    // `vpc-abc` (no angle brackets) continues to pass.
    "<[^>]*>",
  ].join("|") +
  ")";

export const PLACEHOLDER_RESOURCE_ID_REGEX = new RegExp(
  `^(${PLACEHOLDER_RESOURCE_ID_PREFIXES.join("|")})-${PLACEHOLDER_RESOURCE_ID_SUFFIX_GROUP}$`,
  "i",
);

/**
 * Regex matching a placeholder resource ID EMBEDDED inside a larger
 * string. Uses non-word-boundary anchors — `(^|[^A-Za-z0-9])` before the
 * prefix and `(?=[^A-Za-z0-9]|$)` after the suffix — because JS `\b`
 * treats `-` as a word boundary (same class of bug that bit e96.W1.B3),
 * and our suffix tokens contain `-`. The anchors exclude prefix / suffix
 * characters that are a letter, digit, or underscore-like; `-`, `(`,
 * `)`, `.`, `,`, space, quotes, and end-of-string all count as
 * "outside the token".
 *
 * Capture group 2 is the full `<prefix>-<suffix>` placeholder token so
 * the prose walker can surface the exact token in the error message.
 *
 * e96.W3.N1 — introduced for prose-scope detection.
 */
export const PLACEHOLDER_RESOURCE_ID_EMBEDDED_REGEX = new RegExp(
  "(^|[^A-Za-z0-9])" +
    `((${PLACEHOLDER_RESOURCE_ID_PREFIXES.join("|")})-${PLACEHOLDER_RESOURCE_ID_SUFFIX_GROUP})` +
    "(?=[^A-Za-z0-9]|$)",
  "i",
);

/**
 * Field-name suffixes whose values the walker treats as prose (scanned
 * with the embedded regex) rather than ID-shaped (scanned with the
 * anchored regex). Match is case-insensitive against the LAST path
 * segment after the final `.` (so `DistributionConfig.Comment` matches
 * `Comment`, `VpcTags[0].Value` matches `Value` when the parent key
 * indicates a tag context, etc.).
 *
 * Kept narrow on purpose: broad prose scanning would false-positive
 * on legitimate freeform text that happens to mention `subnet-12345678`
 * in a docstring. These are the names the LLM actually hallucinates
 * placeholder tokens inside per F-002.
 */
export const PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS: readonly string[] = [
  "Description",
  "Name",
  "Comment",
];

function isProsePath(path: string): boolean {
  const last = path
    .split(/[.[\]]/)
    .filter(Boolean)
    .pop();
  if (!last) return false;
  const lowered = last.toLowerCase();
  // Tags / tagsets: the Value of a `{Key: "...", Value: "..."}` pair
  // is freeform prose when the parent array name signals a tag
  // context. Without the parent-context check, every `Value` key in
  // desiredState (e.g. SSM parameter `Value`) would become prose —
  // way too broad.
  if (lowered === "value") {
    return /(^|[.[])(tag|tags|tagset|tagsets|tagspecifications)(\[|\.)/i.test(
      path,
    );
  }
  return PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS.some(
    (n) => n.toLowerCase() === lowered,
  );
}

export function isPlaceholderResourceId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return PLACEHOLDER_RESOURCE_ID_REGEX.test(value);
}

/**
 * Extracts the first embedded placeholder token from a prose string,
 * or `undefined` if none is present. e96.W3.N1 — used by the walker
 * when the current path points at a `Description`/`Name`/`Comment`/
 * tag-`Value` field.
 */
export function findEmbeddedPlaceholderResourceId(
  value: unknown,
): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match = PLACEHOLDER_RESOURCE_ID_EMBEDDED_REGEX.exec(value);
  if (!match) return undefined;
  // Capture group 2 is the full `<prefix>-<suffix>` token.
  return match[2];
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
      // Whole-string placeholder (ID-shaped field).
      if (isPlaceholderResourceId(value)) {
        return { field: path, value };
      }
      // e96.W3.N1 — Description/Name/Comment/tag-Value: the LLM often
      // embeds a placeholder token mid-sentence (e.g. "Public subnet
      // (subnet-<hex>)"). Only run the more permissive embedded scan
      // on paths that look like freeform prose.
      if (isProsePath(path)) {
        const token = findEmbeddedPlaceholderResourceId(value);
        if (token) return { field: path, value: token };
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
