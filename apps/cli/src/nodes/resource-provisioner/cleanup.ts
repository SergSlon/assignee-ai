/**
 * Failure-path cleanup of side-resources allocated by `resourceProvisionerNode`
 * BEFORE the CloudControl `createResource` call (fresh EIPs for NAT Gateways,
 * freshly-imported SSH key pairs for EC2 instances).
 *
 * Contract:
 *   - Idempotent: safe to call more than once; each branch no-ops when
 *     its inputs are empty.
 *   - Best-effort: every AWS failure is swallowed and logged at
 *     info/warn level — the primary failure is what the caller reports.
 *   - Narrow: releases EIPs only if WE allocated them (reused EIPs pass
 *     through untouched so retries can reuse them on the next attempt
 *     — otherwise the reuse design leaks one EIP per failure).
 *
 * SRP: this module changes only when cleanup rules change.
 */

import { RESOURCE_TYPES, createEC2Client } from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { AWS_REGION } from "../../config/constants.js";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";
import { formatErrorForLog } from "./util.js";

export interface CleanupInputs {
  /** AllocationIds allocated fresh in this invocation. Reused EIPs MUST be excluded. */
  eipReleased: Set<string>;
  /** Name of the SSH key pair created in this invocation, or undefined. */
  sshDeleted: string | undefined;
}

export async function cleanupAllocatedResources(
  state: AgentState,
  { eipReleased, sshDeleted }: CleanupInputs,
): Promise<void> {
  // Release EIPs if we allocated any for NatGateway — best-effort cleanup.
  // C1: ONLY release EIPs that were freshly allocated in this invocation.
  // Reused EIPs (found via DescribeAddresses from a prior attempt) must
  // survive so the NEXT retry can also reuse them — otherwise the retry
  // loop defeats the reuse design and we leak one EIP per failure.
  if (
    state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
    eipReleased.size > 0
  ) {
    let ec2: ReturnType<typeof createEC2Client> | undefined;
    try {
      const { ReleaseAddressCommand } = await import("@aws-sdk/client-ec2");
      ec2 = createEC2Client({
        region: AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      for (const freshId of eipReleased) {
        try {
          await ec2.send(new ReleaseAddressCommand({ AllocationId: freshId }));
        } catch (err) {
          // best-effort cleanup — surface so operators can diagnose leaks
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
            extras: {
              phase: "release_eip_after_failure",
              allocationId: freshId,
              error: formatErrorForLog(err),
            },
          });
        }
      }
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
        extras: {
          phase: "release_eip_client_init_failed",
          error: formatErrorForLog(err),
        },
      });
    } finally {
      ec2?.destroy();
    }
  }

  // Delete SSH key pair if we created one — best-effort cleanup
  if (sshDeleted) {
    let ec2: ReturnType<typeof createEC2Client> | undefined;
    try {
      const { DeleteKeyPairCommand } = await import("@aws-sdk/client-ec2");
      ec2 = createEC2Client({
        region: AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      await ec2.send(new DeleteKeyPairCommand({ KeyName: sshDeleted }));
    } catch (err) {
      // best-effort cleanup — surface as info so operators can diagnose key leaks
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
        extras: {
          phase: "delete_ssh_key_after_failure",
          sshKeyName: sshDeleted,
          error: formatErrorForLog(err),
        },
      });
    } finally {
      ec2?.destroy();
    }
  }
}
