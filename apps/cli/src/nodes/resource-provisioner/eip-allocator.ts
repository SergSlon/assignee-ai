/**
 * EIP pre-allocation for NAT Gateway creation.
 *
 * The plan generator writes `AllocationId = EIP_AUTO_ALLOCATE` as a
 * placeholder to avoid leaking EIPs when the user runs `plan` but never
 * `apply`. This module resolves the placeholder at apply time:
 *   1. Check for an EIP tagged with this runId from a prior attempt (reuse).
 *   2. If the prior attempt left multiple EIPs (leak detected), reuse the
 *      first and best-effort-release every *orphan* tail one. Associated
 *      EIPs are left intact.
 *   3. Otherwise allocate a fresh EIP and tag it with
 *      `assignee:runId` + `managed-by=assignee-ai`.
 *
 * Invariants this module guarantees (tested):
 *   - A reused EIP is NEVER added to `freshlyAllocated`; cleanup never
 *     releases it on failure.
 *   - A freshly allocated EIP IS added to `freshlyAllocated` so cleanup
 *     can release it on failure.
 *   - DescribeAddresses AccessDenied is promoted to a warn with an
 *     actionable hint (Wave 19 Bug #5) — we still fall through to a fresh
 *     allocation so the user's apply succeeds (leak-prone until operator
 *     policy is refreshed).
 *
 * SRP: this module changes when EIP reuse/leak-prevention rules change.
 * ISP: depends only on EC2Client from `@aws-sdk/client-ec2`.
 */

import {
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ExecutionStatus,
  RESOURCE_TYPES,
  createEC2Client,
  isAccessDeniedError,
} from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import { log, LOG_ACTIONS } from "../../utils/logger.js";
import { AWS_REGION } from "../../config/constants.js";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../../utils/tags.js";
import { formatErrorForLog } from "./util.js";

export interface EipAllocationSuccess {
  ok: true;
  freshlyAllocated: Set<string>;
}

export interface EipAllocationFailure {
  ok: false;
  partial: Partial<AgentState>;
}

export type EipAllocationResult = EipAllocationSuccess | EipAllocationFailure;

/**
 * Resolve the NAT Gateway EIP placeholder in `desiredState` in place.
 * Only runs when resourceType is EC2::NatGateway AND the placeholder is
 * present — every other path is a no-op that returns an empty fresh set.
 */
export async function allocateNatGatewayEip(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EipAllocationResult> {
  const freshlyAllocatedEipIds = new Set<string>();

  if (
    state.resourceType !== RESOURCE_TYPES.EC2_NAT_GATEWAY ||
    desiredState[CfnKey.ALLOCATION_ID] !== EIP_AUTO_ALLOCATE
  ) {
    return { ok: true, freshlyAllocated: freshlyAllocatedEipIds };
  }

  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    const {
      AllocateAddressCommand,
      DescribeAddressesCommand,
      CreateTagsCommand,
    } = await import("@aws-sdk/client-ec2");
    ec2 = createEC2Client({
      region: AWS_REGION,
      credentials: requireAssigneeCredentials("operator"),
    });

    // Step 1: reuse an EIP tagged with this runId, if any.
    let allocationId: string | undefined;
    try {
      const existing = await ec2.send(
        new DescribeAddressesCommand({
          Filters: [
            { Name: "tag:assignee:runId", Values: [state.runId] },
            { Name: "domain", Values: ["vpc"] },
          ],
        }),
      );
      if (existing.Addresses?.length && existing.Addresses[0]?.AllocationId) {
        allocationId = existing.Addresses[0].AllocationId;
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
          extras: {
            reason: "eip_reuse",
            allocationId,
            message: `Reusing existing EIP ${allocationId} from previous attempt`,
          },
        });
        // L-A6 / P1-3: multiple tagged EIPs mean a prior-attempt leak.
        // Reuse the first; release every orphan tail one (not associated
        // with a NAT/ENI/Instance). Associated EIPs belong to concurrent
        // success paths and must NOT be released.
        if (existing.Addresses.length > 1) {
          const { ReleaseAddressCommand } = await import("@aws-sdk/client-ec2");
          const allAllocationIds = existing.Addresses.map(
            (a) => a.AllocationId,
          ).filter((id): id is string => typeof id === "string");
          const orphanIds: string[] = [];
          const keptIds: string[] = [];
          for (const addr of existing.Addresses) {
            if (!addr.AllocationId || addr.AllocationId === allocationId) {
              continue;
            }
            const isOrphan =
              !addr.AssociationId &&
              !addr.InstanceId &&
              !addr.NetworkInterfaceId;
            if (!isOrphan) {
              keptIds.push(addr.AllocationId);
              continue;
            }
            try {
              await ec2.send(
                new ReleaseAddressCommand({
                  AllocationId: addr.AllocationId,
                }),
              );
              orphanIds.push(addr.AllocationId);
            } catch (relErr) {
              keptIds.push(addr.AllocationId);
              log({
                ts: new Date().toISOString(),
                runId: state.runId,
                level: "warn",
                action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
                extras: {
                  phase: "release_orphan_eip",
                  allocationId: addr.AllocationId,
                  error: formatErrorForLog(relErr),
                },
              });
            }
          }
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "warn",
            action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
            extras: {
              reason: "eip_leak_detected",
              count: existing.Addresses.length,
              reusedAllocationId: allocationId,
              allAllocationIds,
              releasedOrphanIds: orphanIds,
              keptAssociatedIds: keptIds,
              message:
                `Found ${existing.Addresses.length} EIPs tagged with runId ${state.runId} ` +
                `from previous attempts. Reusing ${allocationId}; auto-released ` +
                `${orphanIds.length} orphan EIP(s); ` +
                `${keptIds.length} remain associated and were left intact.`,
            },
          });
        }
      }
    } catch (err) {
      // Wave 19 Bug #5: promote AccessDenied to a warn-level event with
      // an actionable hint so operators can see the stale-policy root cause.
      const isAccessDenied = isAccessDeniedError(err);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: isAccessDenied ? "warn" : "info",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: {
          phase: "describe_addresses_eip_reuse",
          error: formatErrorForLog(err),
          ...(isAccessDenied && {
            hint:
              "Operator role lacks ec2:DescribeAddresses. This is already in " +
              "iam-actions.ts for EC2_NAT_GATEWAY as of Wave 19 Bug #5 — run " +
              "`assignee setup` to refresh AssigneeOperatorPolicy in AWS. " +
              "Falling through to allocate a fresh EIP (leak-prone until " +
              "setup is re-run).",
          }),
        },
      });
    }

    // Step 2: allocate fresh if no reusable EIP was found.
    if (!allocationId) {
      const eipResult = await ec2.send(
        new AllocateAddressCommand({ Domain: "vpc" }),
      );
      allocationId = eipResult.AllocationId;
      if (!allocationId) {
        return {
          ok: false,
          partial: {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage:
              "EIP allocation succeeded but returned no AllocationId.",
            desiredState,
          },
        };
      }
      // C1 / P1-3: track per-id so cleanup only releases what we allocated.
      freshlyAllocatedEipIds.add(allocationId);
      // Wave 19 Bug #6: tag with BOTH runId AND managed-by so the EIP is
      // visible to `fetchManagedResources` and participates in destroy.
      try {
        await ec2.send(
          new CreateTagsCommand({
            Resources: [allocationId],
            Tags: [
              { Key: "assignee:runId", Value: state.runId },
              { Key: TAG_KEY_MANAGED_BY, Value: TAG_VALUE_MANAGED_BY },
            ],
          }),
        );
      } catch (err) {
        // Tagging failure is non-fatal — EIP is still usable.
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: {
            phase: "tag_eip",
            allocationId,
            error: formatErrorForLog(err),
          },
        });
      }
    }

    desiredState[CfnKey.ALLOCATION_ID] = allocationId;
    return { ok: true, freshlyAllocated: freshlyAllocatedEipIds };
  } catch (eipErr: unknown) {
    const errMsg = eipErr instanceof Error ? eipErr.message : String(eipErr);
    return {
      ok: false,
      partial: {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `EIP allocation failed for NatGateway: ${errMsg}`,
        // H9: surface cloned desiredState even on failure so retries can
        // see any mutations.
        desiredState,
      },
    };
  } finally {
    ec2?.destroy();
  }
}
