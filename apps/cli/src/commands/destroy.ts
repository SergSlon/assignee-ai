/**
 * `assignee destroy` command — safely destroys a single managed AWS resource
 * or, with `--all`, bulk-destroys every managed resource with safety guards.
 *
 * Two modes:
 *   1. Single-resource (default): resolve by ARN or name, confirm, delete.
 *   2. Bulk (`--all`): enumerate → filter exclusion allowlist → ordered plan
 *      → typed-account-ID confirmation → sequential destroy → audit event.
 *      Story 50-3 cut `--all` as too dangerous; this re-introduction closes
 *      the v1 safety gap via: dry-run default, unconditional exclusion
 *      allowlist, typed-confirmation gate, and 100-resource hard cap.
 *
 * Wave-6c F2: decomposed into `destroy/` sub-modules. This file is the
 * Commander wrapper, the CCAPI-bypass dispatcher for AWS resource types
 * whose "destroy" is really "schedule for deletion" (Epic 92 e92.1.b:
 * KMS::Key → D-21, SecretsManager::Secret → D-25, Events::EventBus →
 * D-19/D-20), and the re-export surface for tests that import
 * `destroyAction` / `resourceConfirmationToken` from here.
 *
 * Why the CCAPI bypass exists
 * ---------------------------
 * Three AWS types violate the "destroy = gone" contract that the rest
 * of the destroy flow assumes:
 *
 *   - AWS::KMS::Key — CloudControl DeleteResource succeeds asynchronously
 *     but the key lingers in PendingDeletion for 7-30 days, still billing
 *     $1/month and still cryptographically reversible. The user has no
 *     way to pick the window from the generic `destroy` path. We call
 *     `kms:ScheduleKeyDeletion` directly with `--pending-window-in-days`.
 *
 *   - AWS::SecretsManager::Secret — `DeleteSecret` imposes a mandatory
 *     7-30 day recovery window unless `ForceDeleteWithoutRecovery=true`.
 *     CCAPI offers no way to pass either flag. We call `secretsmanager:DeleteSecret`
 *     directly and honour `--recovery-window-in-days` /
 *     `--force-delete-without-recovery`.
 *
 *   - AWS::Events::EventBus — `arn-type-map.ts`'s SERVICE_TYPE_MAP maps
 *     `events` → `AWS::Events::Rule` (a legacy choice pre-dating
 *     EventBus support). So an EventBus ARN resolves with resourceType
 *     `AWS::Events::Rule`, then `arnIdentifierStrategies` routes the
 *     full EventBus ARN to CCAPI DeleteResource for type `AWS::Events::Rule`
 *     — AWS rejects the shape and the bus is orphaned (D-19). We detect
 *     the `event-bus/` resource-section and call `events:DeleteEventBus`
 *     directly by Name, sidestepping the broken classifier.
 *
 * All three paths emit `renderDestroyScheduled` or `renderDestroySuccess`
 * to tell the user the truth: "Scheduled for deletion on <date>" vs
 * "Resource destroyed", never the latter when the former applies.
 *
 * @see Story 18.5, Story 50-3 (bloat cut), Epic 92 e92.1.b (this refactor)
 */

import { Command } from "commander";
import {
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
  CostEstimateLabel,
  UserMessage,
  serializeErrorEnvelope,
} from "@assignee/core";
import * as clack from "@clack/prompts";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { ErrorCode } from "../constants/errors.js";
import { destroyAction as genericDestroyAction } from "./destroy/action.js";
import {
  renderDestroyBox,
  renderDestroySuccess,
  renderDestroyScheduled,
} from "./destroy/result-formatter.js";
import { resourceConfirmationToken } from "./destroy/typed-confirm.js";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants.js";
import {
  createKmsClient,
  createSecretsManagerClient,
  createEventBridgeClient,
} from "../services/cloudcontrol-client.js";
import {
  ScheduleKeyDeletionCommand,
  KMSInvalidStateException,
  NotFoundException as KmsNotFoundException,
} from "@aws-sdk/client-kms";
import {
  DeleteSecretCommand,
  InvalidRequestException as SecretsInvalidRequestException,
  ResourceNotFoundException as SecretsResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import {
  DeleteEventBusCommand,
  ResourceNotFoundException as EventBridgeResourceNotFoundException,
} from "@aws-sdk/client-eventbridge";
import { getCostSavingsEstimate } from "../services/billing.js";
import { getBillingMcpToolsAsync } from "../services/mcp-client.js";
import {
  createTaggingClient,
  isAmbiguousResolution,
  resolveResource,
  type ResolvedResource,
} from "../services/resource-resolver.js";
import { pickFromMatches } from "./destroy/multi-match-prompt.js";
import { startSpinner, stopSpinner } from "../utils/display.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { redactAccountIdIfDemoMode } from "./output-format.js";
import { redactSensitive } from "../utils/error-messages.js";
import { validateAccountId } from "../utils/account-id-validator.js";
import { ProcessExitCode } from "../constants/errors.js";
import { EnvVar } from "../constants/env-vars.js";
import { runBulkDestroyAction } from "./destroy/bulk-action.js";

// ── Re-exports for back-compat (tests + external callers) ─────────────
export { resourceConfirmationToken } from "./destroy/typed-confirm.js";

/**
 * Options accepted by the destroy command.
 *
 * `pendingWindowInDays`: KMS only. AWS accepts 7-30 days (inclusive);
 * default 7 (minimum billing exposure) — rationale: the cost of a
 * mistake is "re-provision the key", not "lost data", because the
 * 7-day window is still enough time for an oncall engineer to cancel
 * the deletion and recover the key material.
 *
 * `recoveryWindowInDays`: SecretsManager only. Same 7-30 range;
 * default 7 for the same rationale.
 *
 * `forceDeleteWithoutRecovery`: SecretsManager only. When true, the
 * secret is destroyed immediately with no recovery window. Use at your
 * own risk; mutually exclusive with `recoveryWindowInDays`.
 */
export interface DestroyOptions {
  yes?: boolean;
  pendingWindowInDays?: string; // Commander string-typed; validated below.
  recoveryWindowInDays?: string;
  forceDeleteWithoutRecovery?: boolean;
  /** Bulk-destroy mode: destroy every managed resource (with safety guards). */
  all?: boolean;
  /**
   * Skip the typed-account-ID confirmation gate (CI/CD only).
   * Commander maps `--no-confirm` to `confirm: false`; set to `false` to skip.
   * Defaults to `true` (confirmation required) when the flag is absent.
   */
  confirm?: boolean;
  /** Allow bulk-destroy of > 100 resources (explicit opt-in). */
  allowLargeSweep?: boolean;
}

const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Parses and validates a window-in-days option string. Throws an
 * AssigneeError with an actionable message when invalid. Returns the
 * numeric value or `undefined` if the option was not provided.
 */
function parseWindowDays(
  raw: string | undefined,
  flagName: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_WINDOW_DAYS || n > MAX_WINDOW_DAYS) {
    throw new AssigneeError(
      `${flagName} must be an integer between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS} days (inclusive). Got "${raw}".`,
      ErrorCode.DESTROY_ERROR,
    );
  }
  return n;
}

/** EventBus ARN resource-section prefix per AWS documented format. */
const EVENTBUS_ARN_RE = /^arn:aws[\w-]*:events:[\w-]*:\d*:event-bus\//;

/** KMS Key ARN resource-section prefix. */
const KMS_KEY_ARN_RE = /^arn:aws[\w-]*:kms:[\w-]*:\d*:key\//;

/** SecretsManager secret ARN resource-section prefix. */
const SECRETS_ARN_RE = /^arn:aws[\w-]*:secretsmanager:[\w-]*:\d*:secret:/;

/**
 * Main action handler for `assignee destroy`.
 *
 * Three-stage dispatch:
 *   1. Validate the argument.
 *   2. Resolve the resource (ARN-or-name) via the shared tagging-API
 *      pipeline so the user's input doesn't have to match exactly.
 *   3. Detect the three CCAPI-bypass cases (KMS / Secrets / EventBus)
 *      and hand off to an inline SDK flow. Everything else falls
 *      through to the shared `genericDestroyAction` (the pre-Epic-92
 *      behavior) via the single-flow path.
 *
 * Exported for unit testing — the Commander wrapper below delegates
 * directly to this.
 */
export async function destroyAction(
  resource: string | undefined,
  opts: DestroyOptions,
): Promise<"already_pending" | void> {
  if (!resource) {
    throw new AssigneeError(
      "Destroy needs to know what to destroy. Pass a resource ARN or name as the positional argument, e.g. `assignee destroy my-bucket` or `assignee destroy arn:aws:s3:::my-bucket`.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  // Validate windows eagerly so the user sees the error before any AWS
  // traffic fires. parseWindowDays throws AssigneeError for out-of-range.
  const pendingWindow = parseWindowDays(
    opts.pendingWindowInDays,
    "--pending-window-in-days",
  );
  const recoveryWindow = parseWindowDays(
    opts.recoveryWindowInDays,
    "--recovery-window-in-days",
  );
  if (opts.forceDeleteWithoutRecovery && recoveryWindow !== undefined) {
    throw new AssigneeError(
      "--force-delete-without-recovery cannot be combined with --recovery-window-in-days. Choose one.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  // Fast-path: if no special flag was passed AND the argument doesn't
  // obviously match KMS/Secrets/EventBus patterns, delegate straight to
  // the existing single-flow. Keeps the S3/Lambda/SG/etc. path 100%
  // untouched (regression-safety — see destroy.test.ts).
  const argMatchesSpecial =
    KMS_KEY_ARN_RE.test(resource) ||
    SECRETS_ARN_RE.test(resource) ||
    EVENTBUS_ARN_RE.test(resource);
  const flagsRequireSpecial =
    pendingWindow !== undefined ||
    recoveryWindow !== undefined ||
    opts.forceDeleteWithoutRecovery === true;
  if (!argMatchesSpecial && !flagsRequireSpecial) {
    return genericDestroyAction(resource, { yes: opts.yes });
  }

  // Special path: resolve, prompt, dispatch to the direct-SDK handler.
  const resolved = await resolveForDestroy(resource, opts.yes);

  // Honest guard: if the user passed KMS/Secrets flags but the resolved
  // resource is not of that type, bail early with an actionable error
  // rather than silently ignoring the flag.
  if (
    pendingWindow !== undefined &&
    resolved.resourceType !== "AWS::KMS::Key"
  ) {
    throw new AssigneeError(
      `--pending-window-in-days only applies to AWS::KMS::Key resources. The resolved resource is ${resolved.resourceType}.`,
      ErrorCode.DESTROY_ERROR,
    );
  }
  if (
    (recoveryWindow !== undefined || opts.forceDeleteWithoutRecovery) &&
    resolved.resourceType !== "AWS::SecretsManager::Secret"
  ) {
    throw new AssigneeError(
      `--recovery-window-in-days and --force-delete-without-recovery only apply to AWS::SecretsManager::Secret resources. The resolved resource is ${resolved.resourceType}.`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  // Detect the actual destroy pathway from the RESOLVED resource.
  // Resource-resolver may classify EventBus ARNs as AWS::Events::Rule
  // (due to the SERVICE_TYPE_MAP bug outside this story's scope), so
  // we ALSO re-check the ARN shape.
  const isKms =
    resolved.resourceType === "AWS::KMS::Key" ||
    KMS_KEY_ARN_RE.test(resolved.arn);
  const isSecret =
    resolved.resourceType === "AWS::SecretsManager::Secret" ||
    SECRETS_ARN_RE.test(resolved.arn);
  const isEventBus = EVENTBUS_ARN_RE.test(resolved.arn);

  // Emit default-window notices BEFORE the confirmation box so the user
  // can make an informed choice. --yes skips the prompt but the notice
  // still prints so CI logs capture the effective window.
  if (isKms && pendingWindow === undefined) {
    process.stderr.write(
      `[destroy] KMS key scheduled NOW for deletion ${DEFAULT_WINDOW_DAYS} days from now` +
        ` (default minimum window; pass --pending-window-in-days <7-30> to extend up to 30 days).` +
        ` AWS does not allow shorter than 7 days for CMK deletion.\n`,
    );
  }
  if (
    isSecret &&
    !opts.forceDeleteWithoutRecovery &&
    recoveryWindow === undefined
  ) {
    process.stderr.write(
      `[destroy] Secret scheduled NOW for deletion ${DEFAULT_WINDOW_DAYS} days from now` +
        ` (default minimum window; pass --recovery-window-in-days <7-30> to extend up to 30 days,` +
        ` or --force-delete-without-recovery to delete immediately).\n`,
    );
  }

  // Cost estimate + confirmation box are the same for every path.
  const billingTools = await getBillingMcpToolsAsync();
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== CostEstimateLabel.NA
      ? savingsEstimate
      : "(cost data unavailable)";

  renderDestroyBox({
    resourceType: resolved.resourceType,
    arn: resolved.arn,
    region: resolved.region,
    identifier: resolved.identifier,
    estimatedMonthlyCost,
  });

  await confirmDestroy(resolved, opts.yes);

  if (isKms) {
    const window = pendingWindow ?? DEFAULT_WINDOW_DAYS;
    const { scheduledAt, outcome } = await scheduleKmsKeyDeletion(
      resolved,
      window,
    );
    if (outcome === "already_pending") {
      process.stderr.write(
        `[destroy] KMS key already scheduled for deletion (pending-delete window in progress).\n`,
      );
      renderDestroyScheduled(scheduledAt, estimatedMonthlyCost);
      return "already_pending";
    }
    renderDestroyScheduled(scheduledAt, estimatedMonthlyCost);
    return;
  }

  if (isSecret) {
    if (opts.forceDeleteWithoutRecovery) {
      const { outcome } = await deleteSecret(resolved, { force: true });
      if (outcome === "already_pending") {
        process.stderr.write(
          `[destroy] Secret already deleted or scheduled for deletion (idempotent success).\n`,
        );
        renderDestroySuccess(estimatedMonthlyCost);
        return "already_pending";
      }
      renderDestroySuccess(estimatedMonthlyCost);
      return;
    }
    const window = recoveryWindow ?? DEFAULT_WINDOW_DAYS;
    const { scheduledAt, outcome } = await deleteSecret(resolved, {
      recoveryDays: window,
    });
    if (outcome === "already_pending") {
      process.stderr.write(
        `[destroy] Secret already deleted or scheduled for deletion (idempotent success).\n`,
      );
      renderDestroySuccess(estimatedMonthlyCost);
      return "already_pending";
    }
    // scheduled path — deleteSecret returns a Date for the scheduled path.
    renderDestroyScheduled(scheduledAt!, estimatedMonthlyCost);
    return;
  }

  if (isEventBus) {
    await deleteEventBus(resolved);
    renderDestroySuccess(estimatedMonthlyCost);
    return;
  }

  // Defensive: we should never land here because argMatchesSpecial
  // only flips true when one of the three patterns matched. Fall
  // back to the generic flow so user input isn't silently dropped.
  return genericDestroyAction(resource, { yes: opts.yes });
}

/**
 * Resolve the user's resource argument via RGTA, rejecting missing /
 * ambiguous inputs with actionable errors. Wraps the same resolver
 * pipeline that single-flow.ts uses — kept inline here so the KMS /
 * Secrets / EventBus bypass can share the code path.
 */
async function resolveForDestroy(
  resource: string,
  yes: boolean | undefined,
): Promise<ResolvedResource> {
  const opCreds = tryAssigneeCredentials("operator");
  const awsConfig = {
    accessKeyId: opCreds?.accessKeyId ?? "",
    secretAccessKey: opCreds?.secretAccessKey ?? "",
    ...(opCreds?.sessionToken ? { sessionToken: opCreds.sessionToken } : {}),
    region: AWS_REGION,
  };
  let taggingClient;
  try {
    taggingClient = createTaggingClient(awsConfig);
  } catch {
    throw new ConfigurationError(
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee setup`.",
    );
  }

  startSpinner("Resolving resource...");
  const resolution = await resolveResource(
    resource,
    taggingClient,
    awsConfig.region || AWS_REGION,
  );
  stopSpinner();

  if (!resolution) {
    throw new AssigneeError(
      `No managed resource found matching "${resource}". Run 'assignee list' to see managed resources.`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  return isAmbiguousResolution(resolution)
    ? await pickFromMatches(resolution, { yes })
    : resolution;
}

/**
 * Enforce the destroy confirmation gate for special-path destroys.
 * Mirrors single-flow.ts so the KMS/Secrets/EventBus CCAPI-bypass paths
 * can never skip typed-name confirmation.
 */
async function confirmDestroy(
  resolved: ResolvedResource,
  yes: boolean | undefined,
): Promise<void> {
  if (yes) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n",
      );
    }
    return;
  }
  if (!process.stdin.isTTY) {
    throw new AssigneeError(
      "Destroy requires confirmation. Use --yes for non-interactive mode.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  const confirmToken = resourceConfirmationToken(resolved);
  const answer = await clack.text({
    message: `Type '${confirmToken}' to confirm destruction, or anything else to cancel:`,
  });

  if (
    clack.isCancel(answer) ||
    typeof answer !== "string" ||
    answer.trim().toLowerCase() !== confirmToken.toLowerCase()
  ) {
    clack.outro(UserMessage.DESTROY_CANCELLED);
    throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
  }
}

/**
 * Outcome of the KMS schedule-key-deletion call.
 * `scheduled` — key was freshly scheduled for deletion now.
 * `already_pending` — key was already in pending-deletion state (idempotent success).
 */
export type KmsDestroyOutcome = "scheduled" | "already_pending";

/**
 * Call `kms:ScheduleKeyDeletion` with the requested pending window.
 * Returns the scheduled-deletion Date that AWS replies with — used by
 * `renderDestroyScheduled` to tell the user exactly when the key
 * will become non-recoverable.
 *
 * Idempotent-success classification (per feedback_cloudcontrol_notfound_short_circuit):
 * - `KMSInvalidStateException` with message containing "pending deletion"
 *   → key was already scheduled; treat as success, return a far-future sentinel date.
 * - `NotFoundException` → key was already deleted and purged; treat as success.
 * All other errors re-throw as AssigneeError (genuine failures).
 */
async function scheduleKmsKeyDeletion(
  resolved: ResolvedResource,
  pendingWindowInDays: number,
): Promise<{ scheduledAt: Date; outcome: KmsDestroyOutcome }> {
  const awsCreds = tryAssigneeCredentials("operator");
  const region = resolved.region || AWS_REGION;
  const kms = createKmsClient(awsCreds ? { ...awsCreds, region } : { region });

  startSpinner("Scheduling KMS key for deletion...");
  try {
    const response = await kms.send(
      new ScheduleKeyDeletionCommand({
        KeyId: resolved.identifier || resolved.arn,
        PendingWindowInDays: pendingWindowInDays,
      }),
    );
    // AWS returns DeletionDate in UTC. Fall back to a client-computed
    // date if the field is missing (shouldn't happen in practice).
    const scheduledAt =
      response.DeletionDate instanceof Date
        ? response.DeletionDate
        : new Date(Date.now() + pendingWindowInDays * 24 * 60 * 60 * 1000);
    return { scheduledAt, outcome: "scheduled" };
  } catch (err) {
    // KMSInvalidStateException with "pending deletion" body: the key was
    // already scheduled in a prior run — idempotent success.
    // Match on error name (code) first; message substring is a secondary
    // guard to avoid treating Disabled/BiYok states the same way.
    if (
      err instanceof KMSInvalidStateException &&
      /pending.?deletion/i.test(err.message)
    ) {
      // We don't know the exact deletion date without a DescribeKey call;
      // return a sentinel date so the renderer can still print something
      // meaningful. The key is already on the path to deletion.
      return {
        scheduledAt: new Date(
          Date.now() + pendingWindowInDays * 24 * 60 * 60 * 1000,
        ),
        outcome: "already_pending",
      };
    }
    // NotFoundException: key was deleted-and-purged in a prior run.
    if (err instanceof KmsNotFoundException) {
      return {
        scheduledAt: new Date(Date.now()),
        outcome: "already_pending",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AssigneeError(
      `Failed to schedule KMS key for deletion: ${message}`,
      ErrorCode.DESTROY_ERROR,
    );
  } finally {
    stopSpinner();
    kms.destroy();
  }
}

/**
 * Outcome of the SecretsManager delete call.
 * `scheduled` — secret was freshly scheduled for deletion.
 * `force_deleted` — secret was force-deleted immediately.
 * `already_pending` — secret was already deleted/scheduled (idempotent success).
 */
export type SecretDestroyOutcome =
  | "scheduled"
  | "force_deleted"
  | "already_pending";

/**
 * Call `secretsmanager:DeleteSecret` with EITHER a recovery window OR
 * force-delete. Returns the ScheduledDeletionDate for the recovery-
 * window path; returns undefined when `force=true` (the secret is
 * gone, not scheduled).
 *
 * Idempotent-success classification:
 * - `InvalidRequestException` with "was deleted" in message → secret already destroyed.
 * - `ResourceNotFoundException` → secret no longer exists.
 * Both are treated as success so re-runs of destroy --all report correctly.
 */
async function deleteSecret(
  resolved: ResolvedResource,
  opts: { force?: boolean; recoveryDays?: number },
): Promise<{ scheduledAt: Date | undefined; outcome: SecretDestroyOutcome }> {
  const awsCreds = tryAssigneeCredentials("operator");
  const region = resolved.region || AWS_REGION;
  const client = createSecretsManagerClient(
    awsCreds ? { ...awsCreds, region } : { region },
  );

  startSpinner(
    opts.force
      ? "Force-deleting secret..."
      : "Scheduling secret for deletion...",
  );
  try {
    const response = await client.send(
      new DeleteSecretCommand({
        SecretId: resolved.arn || resolved.identifier,
        ...(opts.force
          ? { ForceDeleteWithoutRecovery: true }
          : { RecoveryWindowInDays: opts.recoveryDays }),
      }),
    );
    if (opts.force) return { scheduledAt: undefined, outcome: "force_deleted" };
    const scheduledAt =
      response.DeletionDate instanceof Date
        ? response.DeletionDate
        : new Date(
            Date.now() +
              (opts.recoveryDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000,
          );
    return { scheduledAt, outcome: "scheduled" };
  } catch (err) {
    // InvalidRequestException with "was deleted" → secret is already destroyed
    // (either force-deleted previously or currently in scheduled-deletion window).
    if (
      err instanceof SecretsInvalidRequestException &&
      /was deleted|scheduled for deletion/i.test(err.message)
    ) {
      return { scheduledAt: undefined, outcome: "already_pending" };
    }
    // ResourceNotFoundException → secret no longer exists at all.
    if (err instanceof SecretsResourceNotFoundException) {
      return { scheduledAt: undefined, outcome: "already_pending" };
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AssigneeError(
      `Failed to delete secret: ${message}`,
      ErrorCode.DESTROY_ERROR,
    );
  } finally {
    stopSpinner();
    client.destroy();
  }
}

/**
 * Call `events:DeleteEventBus` by name. Bypasses the CCAPI path that
 * mis-routes EventBus ARNs to DeleteRule (D-19).
 */
async function deleteEventBus(resolved: ResolvedResource): Promise<void> {
  const awsCreds = tryAssigneeCredentials("operator");
  const region = resolved.region || AWS_REGION;
  const client = createEventBridgeClient(
    awsCreds ? { ...awsCreds, region } : { region },
  );

  // EventBus Name is the primary identifier; if the ARN is what we
  // have, parse the `event-bus/<name>` tail.
  const nameFromArn = resolved.arn.split("event-bus/").pop();
  const busName =
    resolved.identifier && !resolved.identifier.includes(":")
      ? resolved.identifier
      : nameFromArn;
  if (!busName) {
    throw new AssigneeError(
      `Could not extract an EventBus Name from "${resolved.arn}".`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  startSpinner("Deleting event bus...");
  try {
    await client.send(new DeleteEventBusCommand({ Name: busName }));
  } catch (err) {
    // ResourceNotFoundException → the bus was already deleted (idempotent success).
    // Return normally; the caller will render "Resource destroyed".
    if (err instanceof EventBridgeResourceNotFoundException) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AssigneeError(
      `Failed to delete event bus: ${message}`,
      ErrorCode.DESTROY_ERROR,
    );
  } finally {
    stopSpinner();
    client.destroy();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Commander wrapper
// ─────────────────────────────────────────────────────────────────────

/**
 * Epic 94 Wave 2 N4 (D-08): in `--json` mode, any stdout writes the
 * destroy pipeline emits (`renderDestroyBox`, `renderDestroySuccess`,
 * multi-match prompt) are suppressed; a single top-level envelope is
 * written on completion. Mirrors the pattern added to `plan.ts` /
 * `apply.ts`.
 *
 * Epic 96 Wave 1 B2 (A-02): success envelope now carries optional
 * `runId` / `arn` / `cost` fields so destroy envelopes match the
 * apply contract and CI scripts can reconcile the destroyed ARN
 * against their inventory. All three keys are elided when undefined.
 */
interface DestroySuccessEnvelope {
  ok: true;
  operation: string;
  runId?: string;
  arn?: string;
  identifier?: string;
  cost?: string;
}

function installJsonStdoutSuppressor(enabled: boolean): {
  flushSuccess: (envelope: DestroySuccessEnvelope) => void;
  flushError: (code: string, message: string, hint?: string) => void;
  restore: () => void;
} {
  if (!enabled) {
    return {
      flushSuccess: () => {},
      flushError: () => {},
      restore: () => {},
    };
  }
  const originalWrite = process.stdout.write;
  process.stdout.write = ((
    _chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    process.stdout.write = originalWrite;
    restored = true;
  };

  return {
    flushSuccess: (envelope) => {
      restore();
      originalWrite.call(
        process.stdout,
        redactAccountIdIfDemoMode(JSON.stringify(envelope, null, 2) + "\n"),
      );
    },
    flushError: (code, message, hint) => {
      restore();
      originalWrite.call(
        process.stdout,
        redactAccountIdIfDemoMode(serializeErrorEnvelope(code, message, hint)),
      );
    },
    restore,
  };
}

// ── SEC-047: demo-mode stderr redactor ────────────────────────────────
/**
 * When `ASSIGNEE_DEMO_REDACT_ACCOUNT=1`, installs a process-level stderr
 * interceptor that runs `redactSensitive` on every write. This ensures
 * that AWS SDK error messages emitted to stderr during a demo/screen-
 * recording session do not leak real account IDs or other sensitive
 * strings, mirroring the same protection that `redactAccountIdIfDemoMode`
 * applies to the structured JSON stdout envelope.
 *
 * Returns a `restore` callback the caller MUST invoke in a `finally`
 * block. When demo mode is inactive the function is a no-op.
 */
function installDemoModeStderrRedactor(): { restore: () => void } {
  if (process.env[EnvVar.ASSIGNEE_DEMO_REDACT_ACCOUNT] !== "1") {
    return { restore: () => {} };
  }
  const originalWrite = process.stderr.write;
  process.stderr.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const redacted = redactSensitive(text);
    return (
      originalWrite as (this: NodeJS.WriteStream, ...args: unknown[]) => boolean
    ).call(process.stderr, redacted, ...rest);
  }) as typeof process.stderr.write;

  let restored = false;
  return {
    restore: (): void => {
      if (restored) return;
      process.stderr.write = originalWrite;
      restored = true;
    },
  };
}

/**
 * Extended option shape recognised by the outer Commander wrapper. The
 * json/output keys are read here and stripped before delegating to
 * `destroyAction`, which keeps its own `DestroyOptions` contract
 * untouched (preserving every existing unit test).
 */
type DestroyOptsWithJson = DestroyOptions & {
  json?: boolean;
  output?: string;
  targetAccount?: string;
};

export const destroyCommand = new Command(CommandName.DESTROY)
  .description(CommandDescription.DESTROY)
  // Resource positional is optional — omitted when --all is used.
  .argument("[resource]", CommandArgs.RESOURCE.DESC)
  .option(
    "-y, --yes",
    "Auto-confirm destroy without interactive prompt (for CI/CD)",
  )
  .option(
    "--pending-window-in-days <n>",
    "KMS keys only: pending-deletion window (7-30 days, default 7). KMS keys continue billing until the window elapses.",
  )
  .option(
    "--recovery-window-in-days <n>",
    "SecretsManager secrets only: recovery window (7-30 days, default 7). Secrets continue billing until the window elapses.",
  )
  .option(
    "--force-delete-without-recovery",
    "SecretsManager secrets only: skip the recovery window and destroy the secret immediately. Mutually exclusive with --recovery-window-in-days.",
  )
  // Epic 94 N4 (D-08): parity with plan/list/apply — `--json` is the
  // canonical shorthand for `--output json`. Scripts that piped plan
  // output can now pipe destroy output.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option(
    "--json",
    "Shorthand for --output json (emit machine-readable envelope)",
  )
  // W3-04 (Epic 100 Round 5): multi-account surface flag. Parse + validate
  // only. Cross-account STS assume-role wiring defers to Epic 101.
  .option(
    "--target-account <id>",
    "Target AWS account ID (12 digits). Validates format; cross-account assume-role is not yet supported.",
  )
  // ── Bulk-destroy flags (Story feature-bulk-destroy-with-allowlist) ──
  .option(
    "--all",
    "Bulk-destroy every managed resource (default: dry-run plan). Use --yes to execute.",
  )
  .option(
    "--no-confirm",
    "Skip the typed-account-ID confirmation gate when used with --all --yes (CI/CD escape hatch).",
  )
  .option(
    "--allow-large-sweep",
    "Allow bulk-destroy of more than 100 resources (explicit opt-in to override the safety threshold).",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee destroy arn:aws:s3:::my-bucket
        Destroy a single resource (typed-name confirmation required)
  $ assignee destroy my-bucket --yes
        Non-interactive destroy for CI/CD (skips typed confirmation)
  $ assignee destroy arn:aws:kms:us-east-1:112233445566:key/<uuid> \\
        --pending-window-in-days 7 --yes
        KMS key: schedules deletion with a 7-day window
  $ assignee destroy arn:aws:secretsmanager:us-east-1:112233445566:secret:my-secret \\
        --force-delete-without-recovery --yes
        SecretsManager: immediate delete, no recovery window
  $ assignee destroy my-bucket --yes --json
        Machine-readable envelope for CI scripts
  $ assignee destroy --all
        Dry-run: show what would be destroyed (no AWS writes)
  $ assignee destroy --all --yes
        Bulk-destroy all managed resources (typed-account-ID confirmation required)
  $ assignee destroy --all --yes --no-confirm
        Bulk-destroy without confirmation prompt (CI/CD only)
  $ assignee destroy --all --json
        Machine-readable dry-run plan envelope

Safety: typed-name confirmation is required for single-resource
destroys without --yes. Bulk destroy (--all) defaults to dry-run;
--yes executes with typed-account-ID confirmation.
Assignee self-infrastructure (IAM policies/users/roles) is unconditionally
excluded from bulk destroy — deletion would lock out all assignee commands.

Scheduled-deletion types (KMS keys, SecretsManager secrets) display
"Scheduled for deletion on <date>" rather than "Resource destroyed" —
the resource is still billing and recoverable during the window.
`,
  )
  .action(
    async (resource: string | undefined, rawOpts: DestroyOptsWithJson) => {
      // W3-04 (Epic 100 Round 5): validate --target-account early.
      if (rawOpts.targetAccount !== undefined) {
        const validation = validateAccountId(rawOpts.targetAccount);
        if (!validation.valid) {
          process.stderr.write(
            `[destroy] ${validation.reason ?? "Invalid account ID"}\n`,
          );
          process.exitCode = ProcessExitCode.GENERIC_ERROR;
          return;
        }
        process.stderr.write(
          `[destroy] cross-account assume-role not yet available for ${rawOpts.targetAccount}\n`,
        );
        process.exitCode = ProcessExitCode.NOT_IMPLEMENTED;
        return;
      }

      // ── Bulk-destroy route ──────────────────────────────────────────
      if (rawOpts.all) {
        // Reject: user passed both --all AND a positional resource argument.
        if (resource !== undefined) {
          process.stderr.write(
            `[destroy] ERROR: --all and a resource argument are mutually exclusive.\n` +
              `  Use \`assignee destroy --all\` (no resource) to bulk-destroy,\n` +
              `  or \`assignee destroy <arn>\` (no --all) to destroy a single resource.\n`,
          );
          process.exitCode = ProcessExitCode.GENERIC_ERROR;
          return;
        }

        const json = rawOpts.json === true || rawOpts.output === "json";
        const stderrFilter = installJsonStderrFilter(json);
        const demoStderrRedactor = installDemoModeStderrRedactor();
        try {
          await runBulkDestroyAction({
            yes: rawOpts.yes,
            // Commander maps `--no-confirm` to `confirm: false`
            noConfirm: rawOpts.confirm === false,
            allowLargeSweep: rawOpts.allowLargeSweep,
            json,
            pendingWindowInDays: rawOpts.pendingWindowInDays,
            forceDeleteWithoutRecovery: rawOpts.forceDeleteWithoutRecovery,
            recoveryWindowInDays: rawOpts.recoveryWindowInDays,
            // Inject the full destroyAction so per-resource invocations
            // hit the CCAPI-bypass dispatcher (KMS::ScheduleKeyDeletion,
            // SecretsManager::DeleteSecret with recovery flags, etc.).
            // Without this injection the bulk loop falls back to the
            // generic destroy path which silently drops per-type flags.
            destroyOne: (resource, perResourceOpts) =>
              destroyAction(resource, { ...perResourceOpts, yes: true }),
          });
        } catch (err) {
          if (json) {
            const isTyped = err instanceof AssigneeError;
            const code = isTyped
              ? (err as AssigneeError).code
              : "UNKNOWN_ERROR";
            const message = err instanceof Error ? err.message : String(err);
            process.stdout.write(
              JSON.stringify({
                ok: false,
                operation: "bulk_destroy",
                error: message,
                code,
              }) + "\n",
            );
            process.exitCode = ProcessExitCode.GENERIC_ERROR;
          } else {
            throw err;
          }
        } finally {
          stderrFilter.restore();
          demoStderrRedactor.restore();
        }
        return;
      }

      // ── Single-resource route (unchanged) ──────────────────────────────

      // Normalise `--json` → `--output json`.
      const json = rawOpts.json === true || rawOpts.output === "json";
      const suppressor = installJsonStdoutSuppressor(json);
      // Epic 96 Wave 3 N4 (D-04): suppress renderError human blocks on
      // stderr under JSON mode. The same code/message/hint payload
      // lands on stdout as the error envelope; duplicating it on
      // stderr is noise for machine consumers.
      const stderrFilter = installJsonStderrFilter(json);
      // SEC-047: in demo mode, redact sensitive strings from every stderr
      // write so screen recordings don't leak account IDs via AWS SDK errors.
      const demoStderrRedactor = installDemoModeStderrRedactor();

      try {
        let runErrored: Error | null = null;
        try {
          // destroyAction expects DestroyOptions (no json/output). Strip
          // the envelope flags so the inner function's contract is
          // preserved 1:1 — existing destroyAction unit tests stay valid.
          const inner: DestroyOptions = {
            yes: rawOpts.yes,
            pendingWindowInDays: rawOpts.pendingWindowInDays,
            recoveryWindowInDays: rawOpts.recoveryWindowInDays,
            forceDeleteWithoutRecovery: rawOpts.forceDeleteWithoutRecovery,
          };
          await destroyAction(resource, inner);
        } catch (err) {
          runErrored = err instanceof Error ? err : new Error(String(err));
        }

        if (json) {
          if (runErrored) {
            const isTyped = runErrored instanceof AssigneeError;
            const code = isTyped
              ? (runErrored as AssigneeError).code
              : "UNKNOWN_ERROR";
            const hint = isTyped
              ? ((runErrored as { hint?: string }).hint ??
                "Run `assignee list` to verify the resource ARN or name.")
              : "Run with --verbose for full stack trace.";
            suppressor.flushError(code, runErrored.message, hint);
          } else {
            // Epic 96 Wave 1 B2: the destroy success envelope mirrors
            // apply — `arn` comes from the user-supplied positional
            // (it's the exact resource the CLI destroyed, so it's the
            // most trustworthy field available without threading state
            // back out of `destroyAction`). `runId` / `cost` are only
            // populated when we have them; `destroyAction` does not
            // currently surface either, so we omit rather than emit
            // fake values.
            // F029: when the user passed a name (not an ARN) the heuristic
            // cannot populate `arn`; emit `identifier` instead so CI
            // scripts always have a correlation handle (avoids an empty
            // envelope for the name-based-destroy path).
            const envelope: DestroySuccessEnvelope = {
              ok: true,
              operation: "destroy",
            };
            if (resource && /^arn:aws[\w-]*:/.test(resource)) {
              envelope.arn = resource;
            } else if (resource) {
              envelope.identifier = resource;
            }
            suppressor.flushSuccess(envelope);
          }
        }

        if (runErrored) {
          // Mark alreadyRendered in JSON mode so the top-level Commander
          // catch does not double-paint; in text mode preserve the
          // original error exactly for legacy behaviour.
          if (json) {
            const code =
              runErrored instanceof AssigneeError
                ? runErrored.code
                : "UNKNOWN_ERROR";
            throw new AssigneeError(runErrored.message, code, {
              alreadyRendered: true,
            });
          }
          throw runErrored;
        }
      } finally {
        suppressor.restore();
        stderrFilter.restore();
        demoStderrRedactor.restore();
      }
    },
  );
