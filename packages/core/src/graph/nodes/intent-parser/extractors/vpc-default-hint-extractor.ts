/**
 * VPC default-hint extractor (CP-3, PH1-G-2 Solution B).
 *
 * Detects user intent to use the AWS default VPC or an explicit existing VPC
 * rather than having assignee.ai create a new private VPC. The extractor is
 * deliberately narrow: only hyphenated "vpc-default", two-word "default VPC",
 * and "in the default VPC" (with optional article) are matched. The bare
 * concatenation "vpcdefault" (no separator) does NOT match — word-boundary
 * enforcement is mandatory (Variation F).
 *
 * Returns:
 *   - "default-vpc"                — "vpc-default" / "default VPC" / "in the default VPC"
 *   - "existing-vpc-id:<vpc-id>"  — "existing VPC vpc-XXXXXXX" (ID captured)
 *   - null                         — no match (existing behaviour preserved)
 */

/**
 * Extracts a VPC default/existing hint from a natural-language intent string.
 *
 * Word-boundary semantics:
 *   - "vpc-default" requires the hyphenated form (word boundary on each side).
 *   - "default VPC" requires "default" and "VPC" as separate tokens.
 *   - "existing VPC <vpc-id>" captures the vpc-id verbatim.
 *   - "vpcdefault" (fused, no separator) returns null — Variation F must NOT match.
 */
export function extractVpcDefaultHint(
  intent: string,
): "default-vpc" | `existing-vpc-id:${string}` | null {
  const lower = intent.toLowerCase();

  // Match "existing VPC vpc-XXXXXXXX" — capture the vpc-id.
  // Anchored by word boundaries around "existing" and "vpc-".
  const existingVpcRegex = /\bexisting\s+vpc\s+(vpc-[a-z0-9]+)\b/i;
  const existingMatch = existingVpcRegex.exec(intent);
  if (existingMatch) {
    const vpcId = existingMatch[1]!.toLowerCase();
    return `existing-vpc-id:${vpcId}`;
  }

  // Match "vpc-default" (hyphenated) — word boundary on both ends.
  if (/\bvpc-default\b/.test(lower)) {
    return "default-vpc";
  }

  // Match "default VPC" / "default vpc" / "in the default VPC" — two separate words.
  // \bdefault\b followed by optional whitespace then \bvpc\b.
  if (/\bdefault\s+vpc\b/.test(lower)) {
    return "default-vpc";
  }

  return null;
}
