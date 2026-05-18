/**
 * `assignee infra destroy` command — safely destroys a single managed AWS resource
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
  renderDestroyScheduledUnknown,
} from "./destroy/result-formatter.js";
import { resourceConfirmationToken } from "./destroy/typed-confirm.js";
import { maybeWarnYesInTty } from "./destroy/yes-warning.js";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants.js";
import {
  createKmsClient,
  createSecretsManagerClient,
  createEventBridgeClient,
} from "../services/cloudcontrol-client.js";
import {
  ScheduleKeyDeletionCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  KMSInvalidStateException,
  NotFoundException as KmsNotFoundException,
} from "@aws-sdk/client-kms";
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
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
import { redactSensitive } from "../utils/error-messages.js";
import { installJsonStdoutSuppressor } from "../utils/stdio/json-stdout-suppressor.js";
import { buildOperatorClientConfig } from "../utils/aws/operator-client-config.js";
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
  /**
   * INTERNAL — set by `runBulkDestroyAction` when threading per-resource
   * destroy invocations through `destroyAction`. Signals that the
   * bulk-destroy parent already collected the typed-account-ID
   * confirmation, so per-resource paths should suppress the
   * "--yes flag used in interactive session" warning. Not a public CLI
   * flag (no Commander binding); see `bulk-action.ts` for the only
   * production setter.
   */
  noConfirm?: boolean;
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
 * Main action handler for `assignee infra destroy`.
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
      "Destroy needs to know what to destroy. Pass a resource ARN or name as the positional argument, e.g. `assignee infra destroy my-bucket` or `assignee infra destroy arn:aws:s3:::my-bucket`.",
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
    // Forward `noConfirm` so per-resource invocations triggered by
    // `assignee infra destroy --all` don't re-emit the per-key
    // "--yes flag used in interactive session" warning. The bulk-destroy
    // parent already collected the typed-account-ID confirmation once.
    return genericDestroyAction(resource, {
      yes: opts.yes,
      noConfirm: opts.noConfirm,
    });
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

  // Emit default-window HINTS BEFORE the confirmation box so the user
  // can make an informed choice. --yes skips the prompt but the hint
  // still prints so CI logs capture the effective window.
  //
  // Defect 1 fix (2026-05-09): the previous wording ("KMS key scheduled
  // NOW for deletion 7 days from now") was a lie when the key was
  // already in PendingDeletion — the second ScheduleKeyDeletion call
  // throws KMSInvalidStateException before the notice's claim ever
  // becomes true. The notice now only describes what WILL be attempted
  // (the scheduling call) and what flags adjust it. The honest result
  // line is rendered AFTER the call, in the outcome-aware branches
  // below.
  if (isKms && pendingWindow === undefined) {
    process.stderr.write(
      `[destroy] preparing to destroy KMS key (AWS minimum ${DEFAULT_WINDOW_DAYS}-day waiting period; ` +
        `pass --pending-window-in-days <7-30> to extend up to 30 days).\n`,
    );
  }
  if (
    isSecret &&
    !opts.forceDeleteWithoutRecovery &&
    recoveryWindow === undefined
  ) {
    process.stderr.write(
      `[destroy] preparing to destroy secret (AWS minimum ${DEFAULT_WINDOW_DAYS}-day recovery window; ` +
        `pass --recovery-window-in-days <7-30> to extend up to 30 days, ` +
        `or --force-delete-without-recovery to delete immediately).\n`,
    );
  }

  // Cost estimate + confirmation box are the same for every path.
  const billingTools = await getBillingMcpToolsAsync();
  // Defect 3 fix (2026-05-09): pass the resolved resourceType so the
  // estimator can reach the same per-type decomposer registry that
  // `assignee admin list` uses (KMS → $1.00/mo, etc.) when cost-explorer +
  // provision-log are both silent.
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    resolved.resourceType,
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

  // B5 (S-H-017): inform the operator that KMS destroy first disables
  // the key (kms:DisableKey) before scheduling deletion. If they cancel
  // after the disable step, they must re-enable manually.
  if (isKms) {
    process.stderr.write(
      "[destroy] Note: this KMS key will be disabled (kms:DisableKey) before scheduling deletion. " +
        "If you cancel after disabling, run 'aws kms enable-key --key-id <id>' to restore.\n",
    );
  }

  await confirmDestroy(resolved, opts.yes, opts.noConfirm === true);

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
      // Defect 4 fix (2026-05-09): render the date ONLY when we have
      // a real one from DescribeKey. When the scheduledAt is undefined
      // (DescribeKey failed or the key is purged) we print a neutral
      // line instead of fabricating a synthetic future date — the
      // synthetic date had no relationship to AWS's actual deletion
      // schedule and routinely lied to operators by a week or more.
      if (scheduledAt) {
        renderDestroyScheduled(scheduledAt, estimatedMonthlyCost);
      } else {
        renderDestroyScheduledUnknown(estimatedMonthlyCost);
      }
      return "already_pending";
    }
    // outcome === "scheduled" — scheduledAt is the authoritative
    // DeletionDate returned by ScheduleKeyDeletion (or, failing that,
    // a client-derived date that matches the requested window).
    renderDestroyScheduled(scheduledAt!, estimatedMonthlyCost);
    return;
  }

  if (isSecret) {
    if (opts.forceDeleteWithoutRecovery) {
      const { outcome } = await deleteSecret(resolved, { force: true });
      if (outcome === "already_pending") {
        process.stderr.write(
          `[destroy] Secret already deleted or scheduled for deletion (idempotent success).\n`,
        );
        // Force-delete + already_pending: the secret is genuinely gone
        // (or scheduled for the recovery window in a prior run with the
        // same effect under --force, since force is fully destructive).
        // "Resource destroyed" is honest here.
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
      // Defect 4 symmetry fix (2026-05-09): same as the KMS branch above
      // — when the secret was already scheduled in a prior run, try to
      // recover the real ScheduledDeletionDate via DescribeSecret. If
      // DescribeSecret succeeds, render the honest scheduled-on line;
      // otherwise render the unknown-date line. The previous code
      // printed "Resource destroyed" via renderDestroySuccess, which
      // was a lie — the secret is in a recovery window, not destroyed.
      const realDate = scheduledAt
        ? scheduledAt
        : await tryDescribeSecretDeletionDate(resolved);
      if (realDate) {
        renderDestroyScheduled(realDate, estimatedMonthlyCost);
      } else {
        renderDestroyScheduledUnknown(estimatedMonthlyCost);
      }
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
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee dev setup`.",
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
      `No managed resource found matching "${resource}". Run 'assignee admin list' to see managed resources.`,
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
  noConfirm: boolean = false,
): Promise<void> {
  if (yes) {
    // Suppressed when the bulk-destroy parent already ran the
    // typed-account-ID gate (it threads `noConfirm: true` into the
    // per-resource invocation). Otherwise emits the standard
    // interactive-TTY warning so the operator sees that --yes bypassed
    // the typed-name confirmation.
    maybeWarnYesInTty({ yes, noConfirm });
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
): Promise<{ scheduledAt: Date | undefined; outcome: KmsDestroyOutcome }> {
  const kms = createKmsClient(buildOperatorClientConfig(resolved));

  startSpinner("Scheduling KMS key for deletion...");
  // Defense-in-depth (2026-05-09): pre-disable the key BEFORE scheduling
  // deletion so a cancelled `kms:ScheduleKeyDeletion` (operator runs
  // `kms:CancelKeyDeletion` during the pending window) leaves the key
  // in `Disabled` state instead of silently re-Enabled. Best-effort —
  // any failure is swallowed and the schedule call still runs.
  await tryDisableKmsKey(kms, resolved.identifier || resolved.arn);
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
      // Defect 4 fix (2026-05-09): the previous code fabricated a
      // client-side sentinel `Date.now() + pendingWindowInDays` value
      // here, which lied to operators — the synthetic date had no
      // relationship to AWS's actual scheduled DeletionDate. Replace
      // the sentinel with a DescribeKey call that returns the real
      // DeletionDate. If DescribeKey itself fails (throttle, AccessDenied)
      // we return `scheduledAt: undefined` so the renderer can print a
      // honest "check AWS console for the exact date" line.
      const realDeletionDate = await tryDescribeKmsDeletionDate(
        kms,
        resolved.identifier || resolved.arn,
      );
      return {
        scheduledAt: realDeletionDate,
        outcome: "already_pending",
      };
    }
    // NotFoundException: key was deleted-and-purged in a prior run.
    // No DeletionDate to recover; renderer prints the unknown-date line.
    if (err instanceof KmsNotFoundException) {
      return {
        scheduledAt: undefined,
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
 * Defense-in-depth (2026-05-09) helper: best-effort `kms:DisableKey`
 * BEFORE `kms:ScheduleKeyDeletion`. Pre-flight DescribeKey gates the
 * Disable call to keys whose current state is `Enabled`, so we don't
 * trip InvalidStateException on Disabled / PendingDeletion / etc.
 *
 * Why this matters: ScheduleKeyDeletion alone leaves the key Enabled
 * during the 7–30 day pending window. If the operator runs
 * `kms:CancelKeyDeletion` (e.g. they realised the destroy was wrong),
 * the key returns to its prior state — Enabled — and any application
 * still holding the ARN can decrypt with it again. Pre-disabling
 * forces a cancelled destroy back into `Disabled` state, requiring an
 * explicit `kms:EnableKey` to re-arm. Defense in depth: a cancelled
 * destroy is a near-miss, not a silent re-enablement.
 *
 * Best-effort contract: ANY failure (DescribeKey throttle, AccessDenied,
 * DisableKey failure) is swallowed silently — the parent destroy must
 * still attempt ScheduleKeyDeletion. The IAM policy for `assignee-operator`
 * already grants `kms:DisableKey` (security.ts:53), so AccessDenied is
 * possible only on customer-managed roles. Style matches
 * `tryDescribeKmsDeletionDate` (silent swallow, no logging).
 */
async function tryDisableKmsKey(
  kms: ReturnType<typeof createKmsClient>,
  keyId: string,
): Promise<{ disabled: boolean; reason?: string }> {
  try {
    const describe = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
    const state = describe.KeyMetadata?.KeyState;
    if (state !== "Enabled") {
      return { disabled: false, reason: `state:${state ?? "unknown"}` };
    }
    await kms.send(new DisableKeyCommand({ KeyId: keyId }));
    return { disabled: true };
  } catch (err) {
    return {
      disabled: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Defect 4 (2026-05-09) helper: best-effort DescribeKey to recover the
 * real `KeyMetadata.DeletionDate` for a key that AWS reports as already
 * in PendingDeletion. Returns the date when the call succeeds and the
 * field is populated; returns `undefined` on any failure (the caller
 * renders an honest "check AWS console" line in that case rather than
 * fabricating a synthetic future date).
 */
async function tryDescribeKmsDeletionDate(
  kms: ReturnType<typeof createKmsClient>,
  keyId: string,
): Promise<Date | undefined> {
  try {
    const response = await kms.send(new DescribeKeyCommand({ KeyId: keyId }));
    const deletionDate = response.KeyMetadata?.DeletionDate;
    return deletionDate instanceof Date ? deletionDate : undefined;
  } catch {
    // Any failure (throttle, AccessDenied, transient network) — return
    // undefined and let the renderer print the unknown-date line. We
    // intentionally do NOT throw: the parent destroy already succeeded
    // logically (the key is being deleted), so a DescribeKey failure
    // must not turn that success into a failure.
    return undefined;
  }
}

/**
 * Defect 4 symmetry helper (2026-05-09): best-effort DescribeSecret to
 * recover the real `ScheduledDeletionDate` for a secret that AWS
 * reports as already in the recovery window. Returns the date when the
 * call succeeds and the field is populated; returns `undefined` on any
 * failure.
 *
 * Note: this opens a fresh SecretsManager client (the parent
 * `deleteSecret` call already destroyed its own). The cost is one extra
 * SDK setup but it preserves a strict separation between the destroy
 * call and the recovery-date probe so a Describe failure cannot
 * cascade into the destroy outcome.
 */
async function tryDescribeSecretDeletionDate(
  resolved: ResolvedResource,
): Promise<Date | undefined> {
  const client = createSecretsManagerClient(
    buildOperatorClientConfig(resolved),
  );
  try {
    const response = await client.send(
      new DescribeSecretCommand({
        SecretId: resolved.arn || resolved.identifier,
      }),
    );
    const deletionDate = response.DeletedDate;
    return deletionDate instanceof Date ? deletionDate : undefined;
  } catch {
    return undefined;
  } finally {
    client.destroy();
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
  const client = createSecretsManagerClient(
    buildOperatorClientConfig(resolved),
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
  const client = createEventBridgeClient(buildOperatorClientConfig(resolved));

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
  $ assignee infra destroy arn:aws:s3:::my-bucket
        Destroy a single resource (typed-name confirmation required)
  $ assignee infra destroy my-bucket --yes
        Non-interactive destroy for CI/CD (skips typed confirmation)
  $ assignee infra destroy arn:aws:kms:us-east-1:112233445566:key/<uuid> \\
        --pending-window-in-days 7 --yes
        KMS key: schedules deletion with a 7-day window
  $ assignee infra destroy arn:aws:secretsmanager:us-east-1:112233445566:secret:my-secret \\
        --force-delete-without-recovery --yes
        SecretsManager: immediate delete, no recovery window
  $ assignee infra destroy my-bucket --yes --json
        Machine-readable envelope for CI scripts
  $ assignee infra destroy --all
        Dry-run: show what would be destroyed (no AWS writes)
  $ assignee infra destroy --all --yes
        Bulk-destroy all managed resources (typed-account-ID confirmation required)
  $ assignee infra destroy --all --yes --no-confirm
        Bulk-destroy without confirmation prompt (CI/CD only)
  $ assignee infra destroy --all --json
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
              `  Use \`assignee infra destroy --all\` (no resource) to bulk-destroy,\n` +
              `  or \`assignee infra destroy <arn>\` (no --all) to destroy a single resource.\n`,
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
              // `perResourceOpts.noConfirm` is forwarded so the
              // per-resource `confirmDestroy` warning is suppressed in
              // bulk mode (the bulk parent already gated on the typed
              // account-ID confirmation).
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
      const suppressor =
        installJsonStdoutSuppressor<DestroySuccessEnvelope>(json);
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
                "Run `assignee admin list` to verify the resource ARN or name.")
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
