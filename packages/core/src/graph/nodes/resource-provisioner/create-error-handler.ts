/**
 * CCAPI `createResource` error → reducer partial builder.
 *
 * When the CloudControl create call fails, the orchestrator needs to:
 *   1. Classify the error into a stable bucket (`classifyCreateError`).
 *   2. Best-effort release any side-resources allocated BEFORE the create
 *      attempt (fresh EIPs, fresh SSH key pairs) via
 *      `cleanupAllocatedResources`.
 *   3. Return a FAILED partial that surfaces the classified message AND
 *      re-exposes the cloned `desiredState` (invariant H9) so retry paths
 *      can reuse allocated side-resources.
 *
 * The pre-53-it1-12 shape walked `createErr.kind` three times via nested
 * ternaries. Story 53-it1-12 collapsed that into `classifyCreateError`.
 * Story 56-it2-03a (closes L7-003 MED) relocated THIS builder out of
 * `resource-provisioner.ts` so the orchestrator is a linear pipeline.
 *
 * SRP: this module changes only when the failure-partial contract changes.
 */

import { ExecutionStatus, ProvisioningError } from "../../../index.js";
import type { ProvisioningPortError } from "../../../ports/provisioning-port.js";
import type { AgentState } from "../../graph-state.js";
import { cleanupAllocatedResources } from "./cleanup.js";
import { classifyCreateError } from "./error-classifier.js";

/**
 * Context passed to `handleCreateError` — gathered at the call site so the
 * helper stays pure (no scope-closure side-effects on reducer state).
 */
export interface CreateErrorCtx {
  readonly state: AgentState;
  readonly createErr: ProvisioningPortError;
  readonly desiredState: Record<string, unknown>;
  readonly freshlyAllocatedEipIds: Set<string>;
  readonly sshKeyCreatedName: string | undefined;
}

/**
 * Build the FAILED reducer partial for a CCAPI `createResource` error.
 *
 * Single-source-of-truth for the three axes (userPrefix, errorCode,
 * shortMessage) — they all come from `classifyCreateError` instead of
 * being re-computed from `createErr.kind` by three parallel nested
 * ternaries (the pre-53-it1-12 shape).
 *
 * Side-effect: invokes `cleanupAllocatedResources` to release EIPs /
 * delete SSH key pairs that were allocated before the CCAPI call failed.
 *
 * Invariant: always surfaces the cloned `desiredState` back to the
 * reducer (H9) so retry paths can reuse allocated side-resources.
 */
export async function handleCreateError(
  ctx: CreateErrorCtx,
): Promise<Partial<AgentState>> {
  const { state, createErr, desiredState } = ctx;
  const classified = classifyCreateError(createErr, state.resourceType);

  await cleanupAllocatedResources(state, {
    eipReleased: ctx.freshlyAllocatedEipIds,
    sshDeleted: ctx.sshKeyCreatedName,
  });

  return {
    executionStatus: ExecutionStatus.FAILED,
    errorMessage: `CloudControl provisioning failed: ${classified.userPrefix}`,
    error: new ProvisioningError(classified.shortMessage, classified.errorCode),
    // H9: ALWAYS surface the cloned desiredState back to the reducer —
    // even on failure — so retries can reuse allocated side-resources.
    desiredState,
  };
}
