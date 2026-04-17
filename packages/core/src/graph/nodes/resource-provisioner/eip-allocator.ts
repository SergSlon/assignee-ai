/**
 * EIP pre-allocation for NAT Gateway creation.
 *
 * The plan generator writes `AllocationId = EIP_AUTO_ALLOCATE` as a
 * placeholder to avoid leaking EIPs when the user runs `plan` but
 * never `apply`. This module resolves the placeholder at apply time
 * via three composable sub-steps (Story 49.6):
 *   1. `findReusableEip` — check for a runId-tagged EIP from a prior attempt.
 *   2. `releaseOrphanEips` — auto-release any orphan leak siblings.
 *   3. `allocateFreshEip` — allocate a new EIP + tag it when nothing to reuse.
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
 * SRP: this module changes when the top-level EIP resolution flow changes.
 * Sub-steps live under `eip-allocator/`.
 */

import {
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ExecutionStatus,
  RESOURCE_TYPES,
  createEC2Client,
} from "@assignee/core";
import type { AgentState } from "../../graph-state.js";
import { AWS_REGION } from "../../../config/constants/aws.js";
import { requireAssigneeCredentials } from "../../../config/aws-credentials.js";
import { findReusableEip } from "./eip-allocator/find-reusable.js";
import { releaseOrphanEips } from "./eip-allocator/release-orphans.js";
import { allocateFreshEip } from "./eip-allocator/allocate-fresh.js";

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
 * Only runs when resourceType is EC2::NatGateway AND the placeholder
 * is present — every other path is a no-op that returns an empty
 * fresh set.
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
    ec2 = createEC2Client({
      region: AWS_REGION,
      credentials: requireAssigneeCredentials("operator"),
    });

    // Step 1: look for a reusable EIP from a prior attempt.
    const reuse = await findReusableEip(ec2, state);
    let allocationId = reuse.allocationId;

    if (allocationId) {
      // Step 2: release orphan siblings (leak recovery).
      await releaseOrphanEips(ec2, state, allocationId, reuse.addresses);
    } else {
      // Step 3: allocate a fresh EIP when nothing to reuse.
      const fresh = await allocateFreshEip(ec2, state);
      if (!fresh.ok) {
        return {
          ok: false,
          partial: {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: fresh.error,
            desiredState,
          },
        };
      }
      allocationId = fresh.allocationId;
      // C1 / P1-3: track per-id so cleanup only releases what we allocated.
      freshlyAllocatedEipIds.add(allocationId);
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
