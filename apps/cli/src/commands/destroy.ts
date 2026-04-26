/**
 * `assignee destroy` command — safely destroys a single managed AWS resource.
 *
 * Single-resource mode only: resolves by ARN or name, confirms, deletes.
 * Story 50-3 cut `--all` and `--include-iam` — bulk destroy was too
 * dangerous for v1 (the safety-allowlist was tacit admission of that).
 * Callers needing to remove many resources invoke destroy per-resource.
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
import { validateAccountId } from "../utils/account-id-validator.js";
import { ProcessExitCode } from "../constants/errors.js";

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
): Promise<void> {
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
    const scheduledAt = await scheduleKmsKeyDeletion(resolved, window);
    renderDestroyScheduled(scheduledAt, estimatedMonthlyCost);
    return;
  }

  if (isSecret) {
    if (opts.forceDeleteWithoutRecovery) {
      await deleteSecret(resolved, { force: true });
      renderDestroySuccess(estimatedMonthlyCost);
      return;
    }
    const window = recoveryWindow ?? DEFAULT_WINDOW_DAYS;
    const scheduledAt = await deleteSecret(resolved, { recoveryDays: window });
    // deleteSecret returns a Date for the scheduled path.
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
 * Call `kms:ScheduleKeyDeletion` with the requested pending window.
 * Returns the scheduled-deletion Date that AWS replies with — used by
 * `renderDestroyScheduled` to tell the user exactly when the key
 * will become non-recoverable.
 */
async function scheduleKmsKeyDeletion(
  resolved: ResolvedResource,
  pendingWindowInDays: number,
): Promise<Date> {
  const { KMSClient, ScheduleKeyDeletionCommand } =
    await import("@aws-sdk/client-kms");
  const awsCreds = tryAssigneeCredentials("operator");
  const kms = new KMSClient({
    region: resolved.region || AWS_REGION,
    ...(awsCreds
      ? {
          credentials: {
            accessKeyId: awsCreds.accessKeyId,
            secretAccessKey: awsCreds.secretAccessKey,
            // W2-01: pass session token for STS/SSO short-term credentials.
            ...(awsCreds.sessionToken
              ? { sessionToken: awsCreds.sessionToken }
              : {}),
          },
        }
      : {}),
  });

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
    return scheduledAt;
  } catch (err) {
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
 * Call `secretsmanager:DeleteSecret` with EITHER a recovery window OR
 * force-delete. Returns the ScheduledDeletionDate for the recovery-
 * window path; returns undefined when `force=true` (the secret is
 * gone, not scheduled).
 */
async function deleteSecret(
  resolved: ResolvedResource,
  opts: { force?: boolean; recoveryDays?: number },
): Promise<Date | undefined> {
  const { SecretsManagerClient, DeleteSecretCommand } =
    await import("@aws-sdk/client-secrets-manager");
  const awsCreds = tryAssigneeCredentials("operator");
  const client = new SecretsManagerClient({
    region: resolved.region || AWS_REGION,
    ...(awsCreds
      ? {
          credentials: {
            accessKeyId: awsCreds.accessKeyId,
            secretAccessKey: awsCreds.secretAccessKey,
            // W2-01: pass session token for STS/SSO short-term credentials.
            ...(awsCreds.sessionToken
              ? { sessionToken: awsCreds.sessionToken }
              : {}),
          },
        }
      : {}),
  });

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
    if (opts.force) return undefined;
    const scheduledAt =
      response.DeletionDate instanceof Date
        ? response.DeletionDate
        : new Date(
            Date.now() +
              (opts.recoveryDays ?? DEFAULT_WINDOW_DAYS) * 24 * 60 * 60 * 1000,
          );
    return scheduledAt;
  } catch (err) {
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
  const { EventBridgeClient, DeleteEventBusCommand } =
    await import("@aws-sdk/client-eventbridge");
  const awsCreds = tryAssigneeCredentials("operator");
  const client = new EventBridgeClient({
    region: resolved.region || AWS_REGION,
    ...(awsCreds
      ? {
          credentials: {
            accessKeyId: awsCreds.accessKeyId,
            secretAccessKey: awsCreds.secretAccessKey,
            // W2-01: pass session token for STS/SSO short-term credentials.
            ...(awsCreds.sessionToken
              ? { sessionToken: awsCreds.sessionToken }
              : {}),
          },
        }
      : {}),
  });

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

/**
 * Extended option shape recognised by the outer Commander wrapper. The
 * json/output keys are read here and stripped before delegating to
 * `destroyAction`, which keeps its own `DestroyOptions` contract
 * untouched (preserving every existing unit test).
 */
type DestroyOptsWithJson = DestroyOptions & {
  json?: boolean;
  output?: string;
};

export const destroyCommand = new Command(CommandName.DESTROY)
  .description(CommandDescription.DESTROY)
  .argument("<resource>", CommandArgs.RESOURCE.DESC)
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
    "Target AWS account ID (12 digits). W3-04 scaffold: parses and validates only; cross-account assume-role wiring is Epic 101.",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee destroy arn:aws:s3:::my-bucket
        Destroy a single resource (typed-name confirmation required)
  $ assignee destroy my-bucket --yes
        Non-interactive destroy for CI/CD (skips typed confirmation)
  $ assignee destroy arn:aws:kms:us-east-1:210987654321:key/<uuid> \\
        --pending-window-in-days 7 --yes
        KMS key: schedules deletion with a 7-day window
  $ assignee destroy arn:aws:secretsmanager:us-east-1:210987654321:secret:my-secret \\
        --force-delete-without-recovery --yes
        SecretsManager: immediate delete, no recovery window
  $ assignee destroy my-bucket --yes --json
        Machine-readable envelope for CI scripts

Safety: typed-name confirmation is required for single-resource
destroys without --yes. Bulk destroy (--all) was removed in Story 50-3;
run destroy per-resource instead.

Scheduled-deletion types (KMS keys, SecretsManager secrets) display
"Scheduled for deletion on <date>" rather than "Resource destroyed" —
the resource is still billing and recoverable during the window.
`,
  )
  .action(
    async (resource: string | undefined, rawOpts: DestroyOptsWithJson) => {
      // W3-04 (Epic 100 Round 5): validate --target-account early.
      type DestroyOptsWithTarget = DestroyOptsWithJson & {
        targetAccount?: string;
      };
      const rawOptsWithTarget = rawOpts as DestroyOptsWithTarget;
      if (rawOptsWithTarget.targetAccount !== undefined) {
        const validation = validateAccountId(rawOptsWithTarget.targetAccount);
        if (!validation.valid) {
          process.stderr.write(
            `[destroy] ${validation.reason ?? "Invalid account ID"}\n`,
          );
          process.exit(ProcessExitCode.GENERIC_ERROR);
          return;
        }
        process.stderr.write(
          `[destroy] Epic 101: cross-account assume-role not yet implemented for ${rawOptsWithTarget.targetAccount}\n`,
        );
        process.exit(ProcessExitCode.NOT_IMPLEMENTED);
        return;
      }

      // Normalise `--json` → `--output json`.
      const json = rawOpts.json === true || rawOpts.output === "json";
      const suppressor = installJsonStdoutSuppressor(json);
      // Epic 96 Wave 3 N4 (D-04): suppress renderError human blocks on
      // stderr under JSON mode. The same code/message/hint payload
      // lands on stdout as the error envelope; duplicating it on
      // stderr is noise for machine consumers.
      const stderrFilter = installJsonStderrFilter(json);

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
            const envelope: DestroySuccessEnvelope = {
              ok: true,
              operation: "destroy",
            };
            if (resource && /^arn:aws[\w-]*:/.test(resource)) {
              envelope.arn = resource;
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
      }
    },
  );
