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

import { RESOURCE_TYPES, createEC2Client } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { requireAssigneeCredentials } from "@/config/aws-credentials.js";
import { formatErrorForLog } from "./util.js";
import type { SshIamCreated } from "./ssh-iam.js";

export interface CleanupInputs {
  /** AllocationIds allocated fresh in this invocation. Reused EIPs MUST be excluded. */
  eipReleased: Set<string>;
  /** Name of the SSH key pair created in this invocation, or undefined. */
  sshDeleted: string | undefined;
  /**
   * SSH-bundle IAM artifacts created in this invocation, or undefined when
   * the SSH-IAM pre-hook didn't run / was a no-op. Each field is independently
   * cleaned up best-effort in IAM-required teardown order.
   */
  sshIamCreated?: SshIamCreated | undefined;
}

export async function cleanupAllocatedResources(
  state: AgentState,
  { eipReleased, sshDeleted, sshIamCreated }: CleanupInputs,
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

  // SSH-bundle IAM teardown — release any role/profile/policy attachment
  // we created. Order matters per IAM API:
  //   RemoveRoleFromInstanceProfile → DeleteInstanceProfile →
  //   DetachRolePolicy → DeleteRole.
  // NoSuchEntity / NotFound are tolerated (idempotent — anything already
  // gone is a partial-failure recovery success).
  if (
    sshIamCreated &&
    (sshIamCreated.roleName ||
      sshIamCreated.profileName ||
      sshIamCreated.attachedPolicyArn ||
      sshIamCreated.roleAddedToProfile)
  ) {
    let iam:
      | { send: (cmd: unknown) => Promise<unknown>; destroy: () => void }
      | undefined;
    try {
      const {
        IAMClient,
        RemoveRoleFromInstanceProfileCommand,
        DeleteInstanceProfileCommand,
        DetachRolePolicyCommand,
        DeleteRoleCommand,
      } = await import("@aws-sdk/client-iam");
      const creds = requireAssigneeCredentials("operator");
      iam = new IAMClient({
        region: AWS_REGION,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
        },
      }) as unknown as {
        send: (cmd: unknown) => Promise<unknown>;
        destroy: () => void;
      };

      const swallow = async (
        phase: string,
        fn: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          await fn();
        } catch (err) {
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
            extras: { phase, error: formatErrorForLog(err) },
          });
        }
      };

      // Step 1: detach role from profile (only if we successfully added it).
      if (
        sshIamCreated.roleAddedToProfile &&
        sshIamCreated.profileName &&
        sshIamCreated.roleName
      ) {
        await swallow("ssh_iam_remove_role_from_profile", () =>
          iam!.send(
            new RemoveRoleFromInstanceProfileCommand({
              InstanceProfileName: sshIamCreated.profileName,
              RoleName: sshIamCreated.roleName,
            }),
          ),
        );
      }
      // Step 2: delete the instance profile.
      if (sshIamCreated.profileName) {
        await swallow("ssh_iam_delete_instance_profile", () =>
          iam!.send(
            new DeleteInstanceProfileCommand({
              InstanceProfileName: sshIamCreated.profileName,
            }),
          ),
        );
      }
      // Step 3: detach the managed policy from the role.
      if (sshIamCreated.attachedPolicyArn && sshIamCreated.roleName) {
        await swallow("ssh_iam_detach_policy", () =>
          iam!.send(
            new DetachRolePolicyCommand({
              RoleName: sshIamCreated.roleName,
              PolicyArn: sshIamCreated.attachedPolicyArn,
            }),
          ),
        );
      }
      // Step 4: delete the role.
      if (sshIamCreated.roleName) {
        await swallow("ssh_iam_delete_role", () =>
          iam!.send(
            new DeleteRoleCommand({ RoleName: sshIamCreated.roleName }),
          ),
        );
      }
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
        extras: {
          phase: "ssh_iam_client_init_failed",
          error: formatErrorForLog(err),
        },
      });
    } finally {
      iam?.destroy();
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
