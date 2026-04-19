/**
 * CCAPI-gap redirect guard.
 *
 * A tiny handful of CloudFormation resource types are not supported by
 * CloudControl's generic create API. Instead of letting the CCAPI call
 * fail with an opaque schema error, the orchestrator consults a map
 * (`CCAPI_REDIRECT_TYPES`) and returns a `FAILED` partial with a
 * friendly "use X instead" message.
 *
 * Story 50-7 removed the last SDK write path, so this file is purely a
 * classifier — there is no fallback. The only remaining redirect entries
 * are:
 *   - AWS::Lambda::Permission          → AWS::Lambda::PermissionPolicy
 *   - AWS::ElastiCache::ReplicationGroup → AWS::ElastiCache::ServerlessCache
 *
 * Story 56-it2-03a (closes L7-003 MED) relocated this guard out of
 * `resource-provisioner.ts` so the orchestrator stays ≤ 80 LOC.
 *
 * SRP: this module changes only when CCAPI-gap redirects change.
 */

import {
  CCAPI_REDIRECT_TYPES,
  ExecutionStatus,
  PROVISIONING_ERROR_CODES,
  ProvisioningError,
} from "@/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";

/**
 * Result of classifying a resource type as a CCAPI-gap redirect.
 * Exported so unit tests can assert the discriminator + message shape
 * without going through the log side-effect.
 */
export interface UnsupportedRedirect {
  readonly redirect: true;
  readonly message: string;
}

/**
 * Classifier for CCAPI-gap resource types.
 *
 * Story 50-7: replaces the prior `SDKFallbackDispatcher.isRedirect()` —
 * after A10 removed all SDK write paths there were only two redirect
 * entries left. The map-lookup IS the whole function; a class with
 * two always-false hooks was pure ceremony.
 */
export function classifyUnsupported(
  resourceType: string,
): UnsupportedRedirect | null {
  const alternative = CCAPI_REDIRECT_TYPES[resourceType];
  if (!alternative) return null;
  if (resourceType === "AWS::Lambda::Permission") {
    return {
      redirect: true,
      message:
        "AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.",
    };
  }
  if (resourceType === "AWS::ElastiCache::ReplicationGroup") {
    return {
      redirect: true,
      message:
        "ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.",
    };
  }
  return {
    redirect: true,
    message: `${resourceType} is not supported by CCAPI. Use ${alternative} instead.`,
  };
}

/**
 * If `state.resourceType` is a CCAPI-gap redirect (Lambda::Permission,
 * ElastiCache::ReplicationGroup, …), emit a structured warn-log and
 * return the FAILED reducer partial. Otherwise return `null` and let
 * the caller proceed to the standard CCAPI path.
 *
 * Extracted from the main orchestrator body so the happy-path read is
 * a linear pipeline (state-guard → pre-hooks → CCAPI → result) rather
 * than an inline 25-line block.
 */
export function checkUnsupportedRedirect(
  state: AgentState,
): Partial<AgentState> | null {
  if (!state.resourceType) return null;
  const redirect = classifyUnsupported(state.resourceType);
  if (!redirect) return null;

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "warn",
    action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
    extras: {
      resourceType: state.resourceType,
      dispatchPath: "redirect",
      message: redirect.message,
    },
  });

  return {
    executionStatus: ExecutionStatus.FAILED,
    errorMessage: redirect.message,
    error: new ProvisioningError(
      redirect.message,
      PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE,
    ),
  };
}
