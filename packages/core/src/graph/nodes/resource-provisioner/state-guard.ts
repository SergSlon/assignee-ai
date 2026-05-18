/**
 * FR-15 Read-Before-Write state guard.
 *
 * Before creating a resource, check CloudControl GetResource to surface
 * "already exists" as a Stale Plan error instead of letting the create
 * call fail ambiguously.
 *
 * Decisions encoded here:
 *   - S3 buckets: SKIP the guard. Bucket names are globally unique across
 *     all AWS accounts — a GetResource success can be a bucket owned by a
 *     DIFFERENT account. The CreateResource call itself correctly returns
 *     ALREADY_EXISTS if the name is genuinely taken.
 *   - Unresolved compound identifiers (e.g. RolePolicy = Role+PolicyName,
 *     Route = RouteTable+CIDR): LOG a warn and proceed. Silently skipping
 *     lets a duplicate sneak through; aborting blocks legitimate creates.
 *   - NOT_FOUND: safe to proceed.
 *   - ACCESS_DENIED / other: log warn, proceed. Permission gaps must NOT
 *     block a create if the user intends to try it.
 *
 * SRP: this module changes when state-guard rules change.
 */

import {
  ExecutionStatus,
  getPrimaryIdentifier,
  PROVISIONING_ERROR_CODES,
  ProvisioningError,
  RESOURCE_TYPES,
  type ResourceType,
} from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "@/ports/provisioning-port.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";

export type StateGuardResult =
  | { abort: false }
  | { abort: true; partial: Partial<AgentState> };

export async function runStateGuard(
  state: AgentState,
  provisioner: ProvisioningPort,
  resourceType: ResourceType,
  desiredState: Record<string, unknown>,
): Promise<StateGuardResult> {
  // S3 bucket names are globally unique across ALL AWS accounts. Skip.
  //
  // Epic 92 u.e (D-24): also skip AWS::SecretsManager::Secret. CCAPI's
  // SecretsManager GetResource handler keys on the full secret ARN
  // (`arn:aws:secretsmanager:<region>:<account>:secret:<name>-<6hex>`),
  // but the resource plugin stores the user-friendly `Name` in
  // desiredState at plan time (see `resource-identifiers.ts:39`). Feeding
  // that bare name to GetResource yielded:
  //   `state_guard_skipped reason=... message="Secret Id <name> is not
  //    a valid ARN. Provide a full secret ARN..."`
  // on every Secret apply — noisy warn on every run, no actual value
  // because the create path correctly returns AlreadyExists on a
  // duplicate name. Skip the pre-flight GetResource the same way S3
  // does; the CCAPI create call remains the authoritative "already
  // exists" check.
  const skipStateGuard =
    resourceType === RESOURCE_TYPES.S3_BUCKET ||
    resourceType === RESOURCE_TYPES.SECRETSMANAGER_SECRET;

  const identifier = skipStateGuard
    ? undefined
    : getPrimaryIdentifier(resourceType, desiredState);

  if (!skipStateGuard && !identifier) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.STATE_GUARD_SKIPPED_UNRESOLVED_IDENTIFIER,
      extras: {
        resourceType,
        reason:
          "primary_identifier_unresolved (compound/composite identifier or unresolved parent ref)",
      },
    });
  }

  if (identifier) {
    const [stateGuardErr] = await provisioner.getResource(
      resourceType,
      identifier,
    );

    if (!stateGuardErr) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_ABORT,
        extras: { identifier, resourceType },
      });
      return {
        abort: true,
        partial: {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Resource already exists (${identifier}). Choose a different name and re-run 'assignee infra plan'.`,
          error: new ProvisioningError(
            `Resource already exists (${identifier}). Choose a different name`,
            PROVISIONING_ERROR_CODES.STATE_MISMATCH,
          ),
        },
      };
    }

    if (stateGuardErr.kind !== ProvisioningErrorKind.NOT_FOUND) {
      // Permission/identifier-format errors must not block CREATE.
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: { reason: stateGuardErr.kind, message: stateGuardErr.message },
      });
    } else {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: { reason: "not_found" },
      });
    }
  }

  return { abort: false };
}
