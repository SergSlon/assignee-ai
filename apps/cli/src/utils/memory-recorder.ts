/**
 * Memory recording helpers for provision/failure tracking.
 * Fire-and-forget: failures are logged but never block results.
 *
 * @see Story 19.3, Story 19.4, Story 19.5, Story 20.13
 */

import crypto from "node:crypto";
import {
  defaultErrorHintRegistry,
  AssigneeError,
  ProvisioningError,
  CostEstimateLabel,
} from "@assignee/core";
import { defaultMemoryService } from "../services/memory.js";
import { defaultErrorMessageRegistry } from "./error-messages.js";
import { EnvVar } from "../constants/env-vars.js";
import { ErrorCode } from "../constants/errors.js";
import { log, LOG_ACTIONS } from "./logger.js";
import { UNKNOWN_FALLBACK } from "../config/constants.js";

/**
 * Writes a provision record to the memory log (Story 19.3).
 * Fire-and-forget: failures are logged but never block the apply result.
 */
export async function writeProvisionRecord(
  runId: string,
  resourceType: string,
  resourceArn: string | undefined,
  desiredState: Record<string, unknown> | undefined,
  estimatedMonthlyCost: string | undefined,
): Promise<void> {
  try {
    await defaultMemoryService.appendProvision({
      runId,
      resourceType: resourceType || UNKNOWN_FALLBACK,
      resourceArn: resourceArn ?? "",
      region:
        process.env[EnvVar.AWS_REGION] ??
        process.env[EnvVar.AWS_DEFAULT_REGION] ??
        UNKNOWN_FALLBACK,
      desiredStateHash: crypto
        .createHash("sha256")
        .update(JSON.stringify(desiredState ?? {}))
        .digest("hex"),
      estimatedMonthlyCost: estimatedMonthlyCost ?? CostEstimateLabel.NA,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Writes a failure record to the memory log (Story 19.4).
 * Fire-and-forget: failures are logged but never block the error output.
 */
export async function writeFailureRecord(
  runId: string,
  resourceType: string,
  error: AssigneeError | undefined,
  errorMessage: string | undefined,
): Promise<void> {
  const suggestedFix =
    defaultErrorHintRegistry.getHint(error) ??
    (error ? defaultErrorMessageRegistry.resolve(error).howToFix : "") ??
    "";

  const errorCode =
    error instanceof ProvisioningError
      ? error.provisioningCode
      : error instanceof AssigneeError
        ? error.code
        : ErrorCode.UNKNOWN;

  try {
    await defaultMemoryService.appendFailure({
      runId,
      resourceType: resourceType || UNKNOWN_FALLBACK,
      errorCode,
      errorMessage: errorMessage ?? "Unknown error",
      suggestedFix,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: {
        memoryWriteError: "Failed to write failure record",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Clears stale failure records for a resource type after a successful provision (Story 20.13).
 * Fire-and-forget: failures are logged but never block the apply result.
 */
export async function clearFailureHistory(
  runId: string,
  resourceType: string,
): Promise<void> {
  try {
    await defaultMemoryService.clearFailuresForType(resourceType);
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: {
        memoryWriteError: "Failed to clear failure history",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Upserts a compound pattern record in memory (Story 19.5).
 * Fire-and-forget: failures are logged but never block results.
 */
export async function upsertPatternRecord(
  runId: string,
  patternId: string,
  elicitedOptions: Record<string, unknown>,
): Promise<void> {
  try {
    await defaultMemoryService.upsertPattern({
      pattern: patternId,
      optionsSelected: elicitedOptions,
      count: 1, // upsertPattern handles incrementing
      lastUsed: new Date().toISOString(),
    });
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.RESULT_FORMATTED,
      extras: { memoryWriteError: "Failed to write pattern record" },
    });
  }
}
