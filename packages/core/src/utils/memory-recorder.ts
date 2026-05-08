/**
 * Memory recording helpers for provision/failure tracking.
 * Fire-and-forget: failures are logged but never block results.
 *
 * @see Story 19.3, Story 19.4, Story 19.5, Story 20.13
 */

import crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { defaultErrorHintRegistry } from "../errors/hint-registry.js";
import { AssigneeError, ProvisioningError } from "../errors.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";
import { defaultMemoryService } from "../services/memory.js";
import { defaultErrorMessageRegistry } from "./error-messages/index.js";
import { EnvVar } from "../constants/env-vars.js";
import { ErrorCode } from "../constants/errors.js";
import { log, LOG_ACTIONS } from "./logger/index.js";
import { UNKNOWN_FALLBACK } from "../config/cfn-keys/defaults.js";
import {
  stripSensitiveFromElicited,
  redactAccountIdsInPrompt,
} from "./redact.js";
// W4-03 (Epic 100 Round 3): advisory lock around provisions.json writes.
import { defaultFileAdvisoryLock } from "../locks/file-advisory-lock.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";

/** Lock name = provisions.json path for advisory-lock serialisation. */
const PROVISIONS_LOCK_NAME = path.join(
  os.homedir(),
  ".assignee",
  "memory",
  "provisions.json",
);

/**
 * Optional extras for `writeProvisionRecord`. Kept as a separate object
 * so future SSH-bundle / drift / reconcile fields can be slotted in
 * without re-reordering the positional arguments at the call sites
 * (apply-single.ts, apply-compound.ts).
 *
 * SSH-bundle Story iv: `publicIpAddressAtApply` is captured one-shot at
 * apply time so `assignee describe` can show `(was <old-ip> at apply
 * time)` when a stop/start cycle changes the EC2 public IP. Apply-time
 * is the only legal write site — describe never updates the field
 * (provision record stays a snapshot of what we provisioned).
 */
export interface ProvisionRecordExtras {
  /** Apply-time PublicIpAddress for EC2; undefined for non-EC2 / private. */
  publicIpAddressAtApply?: string;
  /**
   * bug-s3-bucket-policy-attach-failure-observability — outcome of the
   * apply-time `attachCompensatingBucketPolicy` SDK call for S3 buckets.
   * `true` on success, `false` on attachment failure, undefined for non-
   * S3 resources or when the operator ARN was unavailable (skipped
   * altogether). Persisted on the provision record so `assignee list`
   * can flag buckets where the per-bucket tag-scoped destructive access
   * boundary is NOT in effect.
   */
  compensatingPolicyAttached?: boolean;
  /**
   * bug-s3-bucket-policy-attach-failure-observability — captures the
   * `AttachResult.reason` from a failed `PutBucketPolicy` call so the
   * `assignee list` warning can echo the same message the operator saw
   * on stderr at apply time.
   */
  compensatingPolicyError?: string;
}

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
  config?: ConfigPort,
  extras?: ProvisionRecordExtras,
): Promise<void> {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  // W4-03: advisory lock wraps the full write.
  await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
    try {
      await defaultMemoryService.appendProvision({
        runId,
        resourceType: resourceType || UNKNOWN_FALLBACK,
        resourceArn: resourceArn ?? "",
        region:
          effectiveConfig.get(EnvVar.AWS_REGION) ??
          effectiveConfig.get(EnvVar.AWS_DEFAULT_REGION) ??
          UNKNOWN_FALLBACK,
        desiredStateHash: crypto
          .createHash("sha256")
          .update(JSON.stringify(desiredState ?? {}))
          .digest("hex"),
        estimatedMonthlyCost: estimatedMonthlyCost ?? CostEstimateLabel.NA,
        timestamp: new Date().toISOString(),
        // Story iv: only persist the field when the caller actually
        // captured a public IP (EC2 happy path). Omit the property
        // entirely for non-EC2 / private-subnet resources so the
        // resulting JSON stays free of `"publicIpAddressAtApply": null`
        // / empty-string clutter — Zod-optional means absence is the
        // back-compat baseline.
        ...(extras?.publicIpAddressAtApply &&
        extras.publicIpAddressAtApply.length > 0
          ? { publicIpAddressAtApply: extras.publicIpAddressAtApply }
          : {}),
        // bug-s3-bucket-policy-attach-failure-observability: persist
        // compensating-policy outcome for S3 buckets. `undefined` is
        // omitted from the JSON; `true`/`false` is preserved so list
        // can surface a warning row when the attach failed.
        ...(extras?.compensatingPolicyAttached !== undefined
          ? { compensatingPolicyAttached: extras.compensatingPolicyAttached }
          : {}),
        ...(extras?.compensatingPolicyError &&
        extras.compensatingPolicyError.length > 0
          ? { compensatingPolicyError: extras.compensatingPolicyError }
          : {}),
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
  });
}

/**
 * Writes a failure record to the memory log (Story 19.4).
 * Fire-and-forget: failures are logged but never block the error output.
 *
 * W1-01 (Epic 100): `errorMessage` is passed through
 * `redactAccountIdsInPrompt` before writing to disk — CloudControl error
 * messages routinely contain 12-digit account IDs and full ARNs (e.g.
 * "AccessDenied: arn:aws:iam::210987654321:user/test") that must not be
 * persisted in cleartext to ~/.assignee/memory/failures.json.
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

  // W4-03: advisory lock wraps W1's redactAccountIdsInPrompt + write.
  // W1 invariant: redactAccountIdsInPrompt call site preserved inside lock.
  await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
    // Redact account IDs and ARNs from the raw CloudControl error message
    // before persistence. This is additive over the existing W10-07
    // redactArnsInString call sites — both layers cooperate.
    const safeErrorMessage = redactAccountIdsInPrompt(
      errorMessage ?? "Unknown error",
    );

    try {
      await defaultMemoryService.appendFailure({
        runId,
        resourceType: resourceType || UNKNOWN_FALLBACK,
        errorCode,
        errorMessage: safeErrorMessage,
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
  });
}

/**
 * Clears stale failure records for a resource type after a successful provision (Story 20.13).
 * Fire-and-forget: failures are logged but never block the apply result.
 *
 * bug-clearfailurehistory-appenddestroyedarn-outer-lock-symmetry: wrap the
 * underlying `clearFailuresForType` write in `defaultFileAdvisoryLock.withLock`
 * so the cross-process race against `writeFailureRecord`
 * (failures.json append) can never interleave on a shared workstation. Single-
 * process safety was already provided by sequential awaits, but two terminals
 * running `assignee apply` against the same `~/.assignee/memory/` could
 * theoretically collide without the outer lock.
 */
export async function clearFailureHistory(
  runId: string,
  resourceType: string,
): Promise<void> {
  await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
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
  });
}

/**
 * Records a successfully-destroyed ARN so `fetchManagedResources` can
 * filter it from list output while the AWS resource lingers in INACTIVE
 * state (e.g. ECS clusters stay tagged for ~1h after deletion).
 * Fire-and-forget: failures are logged but never block the destroy result.
 *
 * bug-clearfailurehistory-appenddestroyedarn-outer-lock-symmetry: wrap the
 * underlying `appendDestroyedArn` write in `defaultFileAdvisoryLock.withLock`
 * so cross-process invocations (two terminals running `assignee destroy` on
 * the same workstation) cannot interleave reads/writes on
 * `~/.assignee/memory/destroyed-arns.json`. Mirrors the symmetry of the
 * other 3 writers (`writeProvisionRecord`, `writeFailureRecord`,
 * `upsertPatternRecord`).
 */
export async function appendDestroyedArn(
  runId: string,
  arn: string,
): Promise<void> {
  if (!arn) return;
  await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
    try {
      await defaultMemoryService.appendDestroyedArn(arn);
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
        extras: {
          memoryWriteError: "Failed to record destroyed ARN",
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}

/**
 * Upserts a compound pattern record in memory (Story 19.5).
 * Fire-and-forget: failures are logged but never block results.
 *
 * W1-01 (Epic 100): `sensitiveNames` is the set of elicited-field names that
 * carry credential material (built via `buildSensitiveFieldSet(plugin.fields)`
 * at the call site). When provided, `elicitedOptions` is scrubbed before
 * writing to disk so that passwords and secrets are never persisted in
 * cleartext to ~/.assignee/memory/patterns.json.
 *
 * Callers that do not supply `sensitiveNames` (pre-W1 call sites) continue
 * to work unchanged — the pattern record is written as-is.
 */
export async function upsertPatternRecord(
  runId: string,
  patternId: string,
  elicitedOptions: Record<string, unknown>,
  sensitiveNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  // W4-03: advisory lock wraps W1's stripSensitiveFromElicited + write.
  // W1 invariant: stripSensitiveFromElicited call site preserved inside lock.
  await defaultFileAdvisoryLock.withLock(PROVISIONS_LOCK_NAME, async () => {
    const safeOptions =
      sensitiveNames.size > 0
        ? stripSensitiveFromElicited(elicitedOptions, sensitiveNames)
        : elicitedOptions;

    try {
      await defaultMemoryService.upsertPattern({
        pattern: patternId,
        optionsSelected: safeOptions,
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
  });
}
