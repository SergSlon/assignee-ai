/**
 * KMS alias-based default-CMK resolver — epic-104 Wave C.
 *
 * Goal: prevent CMK accumulation across `assignee apply` runs by
 * lookup-or-creating a single account+region-scoped customer-managed
 * key addressable via the alias `alias/assignee-default-encryption`.
 *
 * Algorithm:
 *   1. Cache hit on (accountId, region) → return cached.
 *   2. ListAliases (paginated) for `alias/assignee-default-encryption`.
 *   3a. Hit → DescribeKey → if KeyState=Enabled return the key arn;
 *       any non-Enabled state throws AssigneeError(KMS_ALIAS_STALE).
 *   3b. Miss → CreateKey (with inline tags) → EnableKeyRotation
 *       (warn-and-continue on failure) → CreateAlias.
 *   4. CreateAlias race: if AlreadyExistsException, schedule the
 *      just-created orphan key for deletion (7-day window) and re-enter
 *      the lookup once. Loop only ONCE — repeated races indicate a
 *      deeper problem.
 *   5. On the create-path, emit an `apply_resource_created` audit event
 *      so Wave B-2's `restore-provisions --from-audit-log` can later
 *      rebuild a provision record for the CMK.
 *
 * Backwards compat: the resolver is a DEFAULT, never a hijack. Callers
 * that already have a user-supplied KmsKeyId / KmsMasterKeyId /
 * KmsKeyIdentifier MUST short-circuit before invoking the resolver.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-key-reuse-via-alias.md
 */

import {
  KMSClient,
  ListAliasesCommand,
  CreateKeyCommand,
  CreateAliasCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  ScheduleKeyDeletionCommand,
  type AliasListEntry,
  type Tag as KmsTag,
} from "@aws-sdk/client-kms";

import { AssigneeError } from "../errors.js";
import { log, LOG_ACTIONS } from "../utils/logger/index.js";
import { appendAuditRecord } from "../audit/audit-log.js";
import type { ApplyResourceCreatedEvent } from "../utils/memory-recorder.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";

/** The account-scoped alias name that addresses the default CMK. */
export const DEFAULT_KMS_ALIAS_NAME = "alias/assignee-default-encryption";

/** Pending-deletion window for orphan keys after a CreateAlias race. */
const ORPHAN_PENDING_DELETION_DAYS = 7;

/** Page cap for ListAliases — 1000 aliases is well above any plausible CMK count. */
const MAX_LIST_ALIASES_PAGES = 10;

/**
 * Result returned by `resolveOrCreateDefaultKmsKey`.
 */
export interface ResolveDefaultKmsKeyResult {
  /** Full ARN of the resolved CMK (always present, even on the cache-hit path). */
  keyArn: string;
  /** The alias name (constant). Returned for symmetry / loggability. */
  aliasName: string;
  /** True iff this call created the CMK + alias. False on cache hit / lookup hit. */
  created: boolean;
}

/**
 * Options for `resolveOrCreateDefaultKmsKey`.
 */
export interface ResolveDefaultKmsKeyOptions {
  /**
   * Pre-constructed KMSClient. The resolver does NOT construct its own
   * client — credential resolution + region-binding belong to the
   * caller. This mirrors the lazy-credential-resolution pattern used
   * by `cloudcontrol-client.ts` factories.
   */
  kms: KMSClient;
  /**
   * AWS account id used as the per-process cache key (paired with region).
   * Callers typically resolve this from `sts:GetCallerIdentity` once at
   * session start; the resolver does not call STS itself.
   */
  accountId: string;
  /** Region the KMS client is bound to. Cache key + log/audit field. */
  region: string;
  /** Run id for audit-log + structured-log correlation. Optional in tests. */
  runId?: string;
}

/**
 * Per-process cache. Keyed by `${accountId}:${region}` so a multi-region
 * apply (compound provisioning across regions) gets one CMK per region.
 *
 * Cleared at process exit (the CLI is one-shot). SaaS callers should
 * call `clearKmsAliasCache()` between tenants to avoid cross-tenant
 * cache poisoning.
 */
const cache = new Map<string, ResolveDefaultKmsKeyResult>();

/**
 * Clears the per-process cache. Test-helper + SaaS multi-tenant entry
 * point.
 */
export function clearKmsAliasCache(): void {
  cache.clear();
}

/**
 * Tags applied to the auto-created CMK. The set matches the project's
 * "managed-by=assignee-ai" tagging convention used by every other
 * auto-provisioned construct (SSH-bundle role, EIP, etc.) so list-resources
 * and the destroy command can find the CMK via RGTA / kms:ListResourceTags.
 */
function defaultCmkTags(): KmsTag[] {
  return [
    { TagKey: "managed-by", TagValue: "assignee-ai" },
    { TagKey: "created-by", TagValue: "assignee-ai" },
    { TagKey: "scope", TagValue: "default-encryption" },
  ];
}

/**
 * Paginate `kms:ListAliases` to find the assignee default alias.
 * Returns the alias entry if present; undefined otherwise.
 */
async function findDefaultAlias(
  kms: KMSClient,
): Promise<AliasListEntry | undefined> {
  let marker: string | undefined;
  for (let page = 0; page < MAX_LIST_ALIASES_PAGES; page++) {
    const result = await kms.send(new ListAliasesCommand({ Marker: marker }));
    for (const a of result?.Aliases ?? []) {
      if (a.AliasName === DEFAULT_KMS_ALIAS_NAME) return a;
    }
    if (!result?.Truncated) break;
    marker = result.NextMarker;
    if (!marker) break;
  }
  return undefined;
}

/**
 * Look up the existing default alias's underlying KeyArn. Throws
 * AssigneeError(KMS_ALIAS_STALE) when the underlying key is in any
 * state other than `Enabled` so the operator inspects the situation
 * (Disabled / PendingDeletion / PendingImport all need manual action;
 * silently re-pointing the alias would mask the operator's intent).
 */
async function describeAliasedKey(
  kms: KMSClient,
  aliasName: string,
): Promise<string> {
  const result = await kms.send(new DescribeKeyCommand({ KeyId: aliasName }));
  const meta = result?.KeyMetadata;
  if (!meta?.Arn) {
    throw new AssigneeError(
      `KMS alias '${aliasName}' resolved but DescribeKey returned no KeyMetadata.Arn.`,
      "KMS_ALIAS_STALE",
    );
  }
  if (meta.KeyState && meta.KeyState !== "Enabled") {
    throw new AssigneeError(
      `KMS alias '${aliasName}' targets a key in state '${meta.KeyState}'. ` +
        `Resolve manually before retrying: enable the key (kms:EnableKey), ` +
        `cancel a pending deletion (kms:CancelKeyDeletion), or repoint the ` +
        `alias to a healthy CMK (kms:UpdateAlias). The resolver refuses to ` +
        `auto-rotate to avoid masking deliberate operator intent.`,
      "KMS_ALIAS_STALE",
    );
  }
  return meta.Arn;
}

/**
 * Emit an `apply_resource_created` audit event for the auto-created CMK
 * so Wave B-2's `restore-provisions --from-audit-log` can later rebuild
 * the provision record. Failure is non-fatal — the CMK is real
 * regardless of whether the audit emit succeeds.
 */
async function emitCmkCreatedAudit(
  keyArn: string,
  region: string,
  runId: string,
): Promise<void> {
  const event: ApplyResourceCreatedEvent = {
    action: "apply_resource_created",
    runId,
    resourceType: "AWS::KMS::Key",
    resourceArn: keyArn,
    region,
    // Reviewer H1 (Wave C): zero hardcoded dollar amounts —
    // `restore-provisions --from-audit-log` writes this straight into
    // provisions.json where `assignee describe`/`list` consume it. Use
    // the canonical `CostEstimateLabel.NA` sentinel (mirrors
    // memory-recorder.ts:141). The follow-up consumer-wiring wave
    // routes through the kms-key pricing decomposer at the call site
    // where state + region are bound.
    estimatedMonthlyCost: CostEstimateLabel.NA,
    desiredStateHash: DEFAULT_KMS_ALIAS_NAME,
    timestamp: new Date().toISOString(),
  };
  try {
    await appendAuditRecord(event);
  } catch (auditErr) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: {
        emitter: "kms-alias-resolver",
        event: "apply_resource_created",
        auditEmitError:
          auditErr instanceof Error ? auditErr.message : String(auditErr),
      },
    });
  }
}

/**
 * Internal: create-path flow. Creates a new CMK, enables rotation,
 * then creates the alias. Handles the CreateAlias race by scheduling
 * the orphan key for deletion (7-day window) and re-entering the
 * lookup ONCE. Emits the apply_resource_created audit event on the
 * happy path.
 */
async function createDefaultCmkAndAlias(
  opts: ResolveDefaultKmsKeyOptions,
  raceRetryCount: number,
): Promise<ResolveDefaultKmsKeyResult> {
  const { kms, region, runId } = opts;
  const correlationRunId = runId ?? "kms-alias-resolver";

  const createKeyResult = await kms.send(
    new CreateKeyCommand({
      Description: "Assignee-managed default encryption key",
      KeyUsage: "ENCRYPT_DECRYPT",
      Tags: defaultCmkTags(),
    }),
  );
  const newKeyId = createKeyResult?.KeyMetadata?.KeyId;
  const newKeyArn = createKeyResult?.KeyMetadata?.Arn;
  if (!newKeyId || !newKeyArn) {
    throw new AssigneeError(
      "kms:CreateKey returned no KeyMetadata.KeyId/Arn — cannot proceed.",
      "KMS_ALIAS_CREATE_FAILED",
    );
  }

  // EnableKeyRotation — non-fatal. If the operator's IAM doesn't carry
  // it (older deployment of the policy) or the API throws, the CMK is
  // still usable; we surface a structured warning so the operator can
  // backfill rotation.
  let rotationFailed: string | undefined;
  try {
    await kms.send(new EnableKeyRotationCommand({ KeyId: newKeyId }));
  } catch (rotErr) {
    rotationFailed = rotErr instanceof Error ? rotErr.message : String(rotErr);
  }

  // CreateAlias — race-aware. AWS surfaces "AlreadyExistsException" when
  // a concurrent caller created the alias between our ListAliases probe
  // and now.
  try {
    await kms.send(
      new CreateAliasCommand({
        AliasName: DEFAULT_KMS_ALIAS_NAME,
        TargetKeyId: newKeyId,
      }),
    );
  } catch (aliasErr) {
    const errName = (aliasErr as { name?: string })?.name ?? "";
    const errMsg =
      aliasErr instanceof Error ? aliasErr.message : String(aliasErr);
    const isAlreadyExists =
      errName === "AlreadyExistsException" ||
      errMsg.includes("AlreadyExistsException") ||
      errMsg.toLowerCase().includes("already exists");
    if (isAlreadyExists && raceRetryCount === 0) {
      // Schedule the just-created orphan key for the minimum 7-day
      // pending window so it doesn't accumulate. Failure here is
      // logged but does NOT block the recovery path — the operator
      // can manually delete the orphan if scheduling fails.
      try {
        await kms.send(
          new ScheduleKeyDeletionCommand({
            KeyId: newKeyId,
            PendingWindowInDays: ORPHAN_PENDING_DELETION_DAYS,
          }),
        );
      } catch (schedErr) {
        log({
          ts: new Date().toISOString(),
          runId: correlationRunId,
          level: "warn",
          action: LOG_ACTIONS.KMS_ALIAS_RACE_LOST,
          extras: {
            orphanedKeyArn: newKeyArn,
            scheduleDeletionError:
              schedErr instanceof Error ? schedErr.message : String(schedErr),
          },
        });
      }
      log({
        ts: new Date().toISOString(),
        runId: correlationRunId,
        level: "warn",
        action: LOG_ACTIONS.KMS_ALIAS_RACE_LOST,
        extras: {
          orphanedKeyArn: newKeyArn,
          orphanScheduledForDeletion: true,
          pendingWindowDays: ORPHAN_PENDING_DELETION_DAYS,
        },
      });
      // Re-enter the lookup. The race winner created the alias, so a
      // fresh ListAliases + DescribeKey returns the racing keyArn.
      const winningAlias = await findDefaultAlias(kms);
      if (!winningAlias?.AliasName) {
        throw new AssigneeError(
          `kms:CreateAlias raced (AlreadyExistsException) but follow-up ListAliases ` +
            `did not surface the racing alias. Aborting to avoid silent retry-loop.`,
          "KMS_ALIAS_RACE_UNRESOLVED",
        );
      }
      const winningKeyArn = await describeAliasedKey(
        kms,
        winningAlias.AliasName,
      );
      return {
        keyArn: winningKeyArn,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        created: false,
      };
    }
    // Non-race CreateAlias failure — propagate.
    throw new AssigneeError(
      `kms:CreateAlias failed for '${DEFAULT_KMS_ALIAS_NAME}': ${errMsg}`,
      "KMS_ALIAS_CREATE_FAILED",
    );
  }

  // Happy path. Audit event + structured log + (if rotation failed)
  // partial-success warning.
  await emitCmkCreatedAudit(newKeyArn, region, correlationRunId);
  log({
    ts: new Date().toISOString(),
    runId: correlationRunId,
    level: "info",
    action: LOG_ACTIONS.KMS_ALIAS_CMK_CREATED,
    extras: {
      keyArn: newKeyArn,
      aliasName: DEFAULT_KMS_ALIAS_NAME,
      tagsApplied: defaultCmkTags().map((t) => `${t.TagKey}=${t.TagValue}`),
      region,
    },
  });
  if (rotationFailed !== undefined) {
    log({
      ts: new Date().toISOString(),
      runId: correlationRunId,
      level: "warn",
      action: LOG_ACTIONS.KMS_ALIAS_RESOLVE_PARTIAL,
      extras: {
        keyArn: newKeyArn,
        aliasName: DEFAULT_KMS_ALIAS_NAME,
        failedStep: "EnableKeyRotation",
        failureReason: rotationFailed,
      },
    });
  }
  return {
    keyArn: newKeyArn,
    aliasName: DEFAULT_KMS_ALIAS_NAME,
    created: true,
  };
}

/**
 * Resolve (or create) the default Assignee-managed CMK addressable via
 * `alias/assignee-default-encryption`. Idempotent and per-process cached.
 *
 * @see DEFAULT_KMS_ALIAS_NAME
 */
export async function resolveOrCreateDefaultKmsKey(
  opts: ResolveDefaultKmsKeyOptions,
): Promise<ResolveDefaultKmsKeyResult> {
  const cacheKey = `${opts.accountId}:${opts.region}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const existing = await findDefaultAlias(opts.kms);
  if (existing?.AliasName) {
    const keyArn = await describeAliasedKey(opts.kms, existing.AliasName);
    const result: ResolveDefaultKmsKeyResult = {
      keyArn,
      aliasName: DEFAULT_KMS_ALIAS_NAME,
      created: false,
    };
    cache.set(cacheKey, result);
    return result;
  }

  const created = await createDefaultCmkAndAlias(opts, 0);
  cache.set(cacheKey, created);
  return created;
}
