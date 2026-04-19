/**
 * Orphan-EIP leak cleanup sub-step of `allocateNatGatewayEip`.
 *
 * L-A6 / P1-3 invariant: multiple EIPs tagged with the same runId mean
 * a prior attempt leaked. Reuse the first; release every orphan tail
 * (not associated with a NAT/ENI/Instance). Associated EIPs belong to
 * concurrent success paths and must NOT be released.
 *
 * @see Story 49.6 (Epic 49) — decompose eip-allocator god function
 */

import type { DescribeAddressesCommandOutput } from "@aws-sdk/client-ec2";
import { ReleaseAddressCommand } from "@aws-sdk/client-ec2";
import type { EC2Client } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { formatErrorForLog } from "../util.js";

type Address = NonNullable<DescribeAddressesCommandOutput["Addresses"]>[number];

/**
 * Release every orphan (unassociated) EIP in `addresses` except
 * `reusedAllocationId`. Swallows per-allocation errors (warn-logged);
 * never throws. No-op when fewer than 2 addresses are present.
 */
export async function releaseOrphanEips(
  ec2: EC2Client,
  state: AgentState,
  reusedAllocationId: string,
  addresses: Address[],
): Promise<void> {
  if (addresses.length <= 1) return;

  const allAllocationIds = addresses
    .map((a) => a.AllocationId)
    .filter((id): id is string => typeof id === "string");
  const orphanIds: string[] = [];
  const keptIds: string[] = [];

  for (const addr of addresses) {
    if (!addr.AllocationId || addr.AllocationId === reusedAllocationId)
      continue;
    const isOrphan =
      !addr.AssociationId && !addr.InstanceId && !addr.NetworkInterfaceId;
    if (!isOrphan) {
      keptIds.push(addr.AllocationId);
      continue;
    }
    try {
      await ec2.send(
        new ReleaseAddressCommand({ AllocationId: addr.AllocationId }),
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
      count: addresses.length,
      reusedAllocationId,
      allAllocationIds,
      releasedOrphanIds: orphanIds,
      keptAssociatedIds: keptIds,
      message:
        `Found ${addresses.length} EIPs tagged with runId ${state.runId} ` +
        `from previous attempts. Reusing ${reusedAllocationId}; auto-released ` +
        `${orphanIds.length} orphan EIP(s); ` +
        `${keptIds.length} remain associated and were left intact.`,
    },
  });
}
