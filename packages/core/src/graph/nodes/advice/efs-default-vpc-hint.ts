/**
 * EFS default-VPC advisory helper (CP-3, PH1-G-2 Solution B).
 *
 * When the user's intent contained "vpc-default" / "default VPC" / "existing VPC"
 * but the plan still creates a new private VPC (via the `efs-with-vpc` compound),
 * this advisor emits a HIGH-visibility advisory that:
 *
 *   1. Names the detected phrase so the user knows their intent was seen.
 *   2. Explains what actually happened (new private VPC was created).
 *   3. Provides the `--set VpcId=<vpc-id> SubnetIds=...` escape hatch.
 *
 * Guard: only fires for `AWS::EFS::FileSystem` resource type AND when
 * `elicitedOptions._VpcDefaultHint` is set by the intent-parser extractor.
 *
 * @see eventbridge-no-target-hint.ts — structural precedent (SX-1)
 * @see vpc-default-hint-extractor.ts — the upstream extractor that sets the key
 */

import { RESOURCE_TYPES } from "@/index.js";
import { AdviceIcon } from "./constants.js";

/** The exact advisory wording from spec line 17. Captured vpc-id flows in for Variation C. */
function buildAdvisoryText(hint: string): string {
  const isExistingVpc = hint.startsWith("existing-vpc-id:");
  const detectedPhrase = isExistingVpc
    ? hint.replace("existing-vpc-id:", "")
    : "vpc-default";

  return (
    `${AdviceIcon.WARNING} Detected 'vpc-default' but assignee.ai currently creates a new private VPC for EFS. ` +
    `To use an existing VPC, run 'assignee plan --set VpcId=<vpc-id> SubnetIds=...'.` +
    (isExistingVpc
      ? ` Detected VPC ID: ${detectedPhrase} — pass it as --set VpcId=${detectedPhrase}.`
      : "")
  );
}

/**
 * Returns an actionable advisory string array (0 or 1 element) when an
 * EFS plan was generated but the user indicated they wanted the default/existing VPC.
 *
 * @param resourceType   - The CloudFormation resource type string.
 * @param elicitedOptions - The elicited options map from the intent-parser node.
 * @returns Array with one advisory string, or empty array if not applicable.
 */
export function efsDefaultVpcHint(
  resourceType: string,
  elicitedOptions: Record<string, unknown>,
): string[] {
  if (resourceType !== RESOURCE_TYPES.EFS_FILE_SYSTEM) {
    return [];
  }

  const hint = elicitedOptions["_VpcDefaultHint"];
  if (typeof hint !== "string") {
    return [];
  }

  return [buildAdvisoryText(hint)];
}
