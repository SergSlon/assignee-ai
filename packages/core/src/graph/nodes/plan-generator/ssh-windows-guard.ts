/**
 * Shared SSH-on-Windows fail-fast guard.
 *
 * When the user intent contains the SSH bundle marker AND the resolved
 * AMI's `Image.PlatformDetails === "Windows"`, throw an
 * `AssigneeError` with code `WINDOWS_SSH_INCOMPATIBLE` BEFORE any
 * KeyName placeholder injection / wizard rendering / keypair creation.
 * The user gets a clear actionable message instead of an apply-time
 * failure that leaves a partially-provisioned EC2 / KMS keypair /
 * security group behind.
 *
 * This guard MUST run on BOTH plan-generator paths — single-resource
 * LLM (`llm-plan/resource-post-process.ts:postProcessEc2Instance`) and
 * compound (`compound-helpers.ts:postProcessEc2Compound`) — because
 * the LLM path is the dominant single-resource flow and a Windows AMI
 * with `ssh` intent would otherwise slip through there.
 *
 * Lookup is best-effort: a transient AWS API blip yields `null` from
 * `getAmiPlatformDetails`, in which case we fall through and assume
 * non-Windows. The keypair-creation path itself fails-soft if the
 * Windows AMI ever lands in apply, so this guard is a UX optimisation
 * (catch the wrong-shape input before any work) rather than a
 * correctness gate.
 *
 * SRP: one reason to change — the SSH-on-Windows fail-fast contract.
 */

import { CfnKey, AssigneeError } from "@/index.js";
import {
  getAmiPlatformDetails,
  PLATFORM_DETAILS_WINDOWS,
} from "@/utils/aws-resource-discovery/ami-default-user.js";
import { isSshIntent } from "@/utils/ssh-intent.js";

/**
 * Error code for SSH-on-Windows fail-fast — see
 * `assertSshIntentNotWindowsAmi`.
 */
export const WINDOWS_SSH_INCOMPATIBLE_CODE = "WINDOWS_SSH_INCOMPATIBLE";

/**
 * Shared fail-fast: throws `AssigneeError(WINDOWS_SSH_INCOMPATIBLE)`
 * when the user intent matches SSH bundle AND the AMI in
 * `desiredState[ImageId]` is a Windows image.
 *
 * No-ops when:
 *   - userIntent is undefined or does not match `\bssh\b`
 *   - desiredState.ImageId is missing or is still an OS-name placeholder
 *     (not yet resolved to `ami-…`) — defense-in-depth so we never
 *     hand a garbage string to DescribeImages
 *   - the AMI lookup returns null (transient API blip → assume
 *     non-Windows; do NOT block the apply on a network glitch)
 */
export async function assertSshIntentNotWindowsAmi(
  desiredState: Record<string, unknown>,
  userIntent: string | undefined,
): Promise<void> {
  if (!isSshIntent(userIntent)) return;
  const imageId = desiredState[CfnKey.IMAGE_ID];
  if (typeof imageId !== "string" || !imageId.startsWith("ami-")) return;
  const platform = await getAmiPlatformDetails(imageId);
  if (platform === PLATFORM_DETAILS_WINDOWS) {
    throw new AssigneeError(
      "Cannot create EC2 with SSH on a Windows AMI. " +
        "Either drop the SSH ask or pick a Linux AMI (al2023, ubuntu-22, etc.).",
      WINDOWS_SSH_INCOMPATIBLE_CODE,
    );
  }
}
