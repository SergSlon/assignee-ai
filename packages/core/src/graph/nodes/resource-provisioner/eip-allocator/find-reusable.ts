/**
 * EIP-reuse sub-step of `allocateNatGatewayEip`. Splits out the
 * DescribeAddresses-based lookup for a prior-attempt EIP matching the
 * current runId. The caller combines the result with the orphan-leak
 * release + fresh-allocation steps.
 *
 * @see Story 49.6 (Epic 49) — decompose eip-allocator god function
 */

import type { DescribeAddressesCommandOutput } from "@aws-sdk/client-ec2";
import { DescribeAddressesCommand } from "@aws-sdk/client-ec2";
import { isAccessDeniedError, type EC2Client } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { formatErrorForLog } from "../util.js";

/** What DescribeAddresses(runId) tells us about the prior attempt. */
export interface ReusableEipLookup {
  /** First reusable EIP's AllocationId, or undefined if none matched. */
  allocationId: string | undefined;
  /** All addresses returned by DescribeAddresses (used for leak triage). */
  addresses: NonNullable<DescribeAddressesCommandOutput["Addresses"]>;
}

/**
 * Look up a reusable EIP tagged with `assignee:runId=<runId>` from a
 * prior attempt. Logs AccessDenied with an actionable hint; never
 * throws. Returns `{ allocationId: undefined, addresses: [] }` when
 * the lookup could not determine a match.
 */
export async function findReusableEip(
  ec2: EC2Client,
  state: AgentState,
): Promise<ReusableEipLookup> {
  try {
    const existing = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [
          { Name: "tag:assignee:runId", Values: [state.runId] },
          { Name: "domain", Values: ["vpc"] },
        ],
      }),
    );
    const addresses = existing.Addresses ?? [];
    const first = addresses[0];
    if (first?.AllocationId) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: {
          reason: "eip_reuse",
          allocationId: first.AllocationId,
          message: `Reusing existing EIP ${first.AllocationId} from previous attempt`,
        },
      });
      return { allocationId: first.AllocationId, addresses };
    }
    return { allocationId: undefined, addresses };
  } catch (err) {
    // Wave 19 Bug #5: promote AccessDenied to warn so operators can
    // see the stale-policy root cause.
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
    return { allocationId: undefined, addresses: [] };
  }
}
