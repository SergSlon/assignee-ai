/**
 * Fresh-EIP allocation sub-step of `allocateNatGatewayEip`.
 *
 * Allocates a new EIP via ec2:AllocateAddress and tags it with BOTH
 * the runId AND `managed-by=assignee-ai` so it shows up in
 * `fetchManagedResources` and participates in destroy. Tagging
 * failure is non-fatal — the EIP is still usable.
 *
 * @see Story 49.6 (Epic 49) — decompose eip-allocator god function
 */

import { AllocateAddressCommand, CreateTagsCommand } from "@aws-sdk/client-ec2";
import type { EC2Client } from "@assignee/core";
import type { AgentState } from "../../../services/graph-state.js";
import { log, LOG_ACTIONS } from "../../../utils/logger.js";
import {
  TAG_KEY_MANAGED_BY,
  TAG_VALUE_MANAGED_BY,
} from "../../../utils/tags.js";
import { formatErrorForLog } from "../util.js";

export type AllocateFreshEipResult =
  | { ok: true; allocationId: string }
  | { ok: false; error: string };

/**
 * AllocateAddress(Domain=vpc) + best-effort tagging. Returns
 * `{ ok: false }` only when AWS returns no AllocationId — tagging
 * failures log-and-continue.
 */
export async function allocateFreshEip(
  ec2: EC2Client,
  state: AgentState,
): Promise<AllocateFreshEipResult> {
  const eipResult = await ec2.send(
    new AllocateAddressCommand({ Domain: "vpc" }),
  );
  const allocationId = eipResult.AllocationId;
  if (!allocationId) {
    return {
      ok: false,
      error: "EIP allocation succeeded but returned no AllocationId.",
    };
  }
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
  return { ok: true, allocationId };
}
