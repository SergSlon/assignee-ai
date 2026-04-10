/**
 * Coherence validator — detects internally inconsistent wizard configurations.
 * Runs after wizard completes, before plan generation. Pure function, no I/O.
 *
 * @see Story 41.5 — Contradiction Detection
 */

import { RESOURCE_TYPES, CfnKey } from "@assignee/core";
import { Port } from "../nodes/advice/constants.js";

export interface CoherenceWarning {
  id: string;
  message: string;
}

/**
 * Checks elicited options for internal contradictions.
 * Returns warnings for impossible or broken configurations.
 */
export function validateCoherence(
  options: Record<string, unknown>,
  intent: string,
  resourceType: string,
): CoherenceWarning[] {
  const warnings: CoherenceWarning[] = [];

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    ec2Coherence(options, warnings);
  } else if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    s3Coherence(options, intent, warnings);
  }

  return warnings;
}

function ec2Coherence(
  options: Record<string, unknown>,
  warnings: CoherenceWarning[],
): void {
  const keyName = options[CfnKey.KEY_NAME] as string | undefined;
  const hasKey = keyName && keyName.length > 0;

  if (!hasKey) return; // No SSH key → no SSH-related contradictions

  // SSH key without public IP
  const publicIp = options["AssociatePublicIpAddress"];
  if (publicIp !== true) {
    warnings.push({
      id: "ssh-no-public-ip",
      message: `SSH key "${keyName}" configured but instance has no public IP \u2014 SSH will not be reachable without a bastion or VPN. Set AssociatePublicIpAddress to true, or use SSM Session Manager instead.`,
    });
  }

  // SSH key without security group allowing port 22
  // We can only check if SG IDs are provided — we can't inspect SG rules from here.
  // The absence of any SG means the default VPC SG is used, which typically doesn't allow port 22.
  const sgIds = options[CfnKey.SECURITY_GROUP_IDS] as string[] | undefined;
  if (!sgIds || sgIds.length === 0) {
    warnings.push({
      id: "ssh-no-sg",
      message: `SSH key "${keyName}" configured but no security group selected \u2014 using the default VPC SG violates BP-EC2-010. A security group with SSH (port ${Port.SSH}) inbound will be auto-created during provisioning.`,
    });
  }
}

function s3Coherence(
  options: Record<string, unknown>,
  intent: string,
  warnings: CoherenceWarning[],
): void {
  const pab = options[CfnKey.PUBLIC_ACCESS_BLOCK] as boolean | undefined;

  // PublicAccessBlock explicitly disabled without "public" in intent
  if (pab === false && !/\bpublic\b/i.test(intent)) {
    warnings.push({
      id: "s3-public-unintended",
      message:
        "Public access is enabled on this bucket \u2014 is this intentional? If not, enable PublicAccessBlockConfiguration.",
    });
  }
}
