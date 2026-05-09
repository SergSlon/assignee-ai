/**
 * apply-time-kms-resolver — epic-104 Wave D-0.
 *
 * Wires the Wave C alias-resolver primitive
 * (`resolveOrCreateDefaultKmsKey`) into the apply-time call path so the
 * 8 KMS-consuming resource plugins (S3, SQS, SNS, EFS, Logs, Secrets,
 * Events EventBus, Events Connection) can opt-in to a single
 * account-and-region-scoped default CMK addressable via
 * `alias/assignee-default-encryption`.
 *
 * # Why this exists
 *
 * Wave C's `resolveOrCreateDefaultKmsKey` requires the caller to pass
 * an `accountId` (paired with `region`) as the per-process cache key —
 * the resolver itself does NOT call STS GetCallerIdentity. The 8
 * plugin pre-hooks that consume the default CMK in Waves D-1…D-8 each
 * need that accountId, but they should NOT each call STS — that's a
 * waste of one round-trip per plugin per apply run AND it duplicates
 * the credential-validation + timeout + caching logic that already
 * lives in `utils/resolve-arn.ts:getOperatorAccountId`.
 *
 * This module is the single seam: one call → STS once (cached, with
 * single-flight coalescing per Wave 10 P1-3) → one
 * `resolveOrCreateDefaultKmsKey` call (cached per
 * `(accountId, region)`).
 *
 * # API
 *
 * `resolveDefaultKmsKeyForApply({ region, kms?, configPort?,
 * accountIdOverride?, runId? })` returns
 * `{ keyArn, aliasName, created, accountId }`.
 *
 * - `region` — required. Determines the KMS client binding + the
 *   alias-resolver cache slot.
 * - `kms` — optional pre-constructed `KMSClient`. When omitted, the
 *   helper constructs one via `createKmsClient` from
 *   `cloudcontrol-client.ts` using `requireAssigneeCredentials("operator")`.
 *   Plugins can pass an existing client to avoid re-authenticating per
 *   call when they already hold one.
 * - `configPort` — reserved for future SaaS plumbing (multi-tenant
 *   credential resolution). Currently unused on the foundation path
 *   but accepted so plugins in D-1…D-8 don't need a signature change
 *   when SaaS support lands.
 * - `accountIdOverride` — bypass STS entirely. Used by tests and by
 *   the future SaaS worker that already knows the tenant's accountId
 *   from an upstream session token.
 * - `runId` — propagated to the underlying resolver for log/audit
 *   correlation. Optional in tests.
 *
 * # IAM
 *
 * `sts:GetCallerIdentity` is implicitly granted by AWS to any
 * authenticated principal — no explicit IAM policy statement is
 * required (and none exists in `iam-policies/operator.ts`). The
 * underlying KMS calls are already covered by the existing operator
 * policy via the Wave C IAM-policy delta. D-0 ships zero IAM changes.
 *
 * # Errors
 *
 * - STS-resolution failure (missing creds, timeout, AccessDenied,
 *   empty Account) → `AssigneeError(KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED)`
 *   with an actionable hint. The KMS resolver is NOT invoked when STS
 *   fails — failing closed avoids creating an orphan CMK in the wrong
 *   account.
 * - KMS-resolver errors (`KMS_ALIAS_STALE`, `KMS_ALIAS_CREATE_FAILED`,
 *   `KMS_ALIAS_RACE_UNRESOLVED`) propagate unchanged.
 *
 * # Pollution discipline
 *
 * The underlying `resolveOrCreateDefaultKmsKey` emits an
 * `apply_resource_created` audit event on the create-path. Tests that
 * exercise the create-path MUST mock `appendAuditRecord` at
 * `audit/audit-log.js` so `~/.assignee/audit/audit.log` does not grow.
 * See the Wave C test file (`kms-alias-resolver.test.ts`) for the
 * canonical pattern.
 *
 * @see _bmad-output/implementation-artifacts/feature-kms-alias-resolver-consumer-wiring-phase-2.md
 * @see packages/core/src/services/kms-alias-resolver.ts
 */

import type { KMSClient } from "@aws-sdk/client-kms";

import { AssigneeError } from "../errors.js";
import type { ConfigPort } from "../config/config-port.js";
import { getOperatorAccountId } from "../utils/resolve-arn.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../config/aws-credentials.js";
import { createKmsClient } from "./cloudcontrol-client.js";
import {
  resolveOrCreateDefaultKmsKey,
  type ResolveDefaultKmsKeyResult,
} from "./kms-alias-resolver.js";
import type { TenantId } from "../tenant/tenant-id.js";

/**
 * Error code emitted when the helper cannot resolve an `accountId` for
 * the apply run. Covers: missing operator credentials, STS timeout,
 * AccessDenied, network failure, or an STS response with no Account
 * field.
 */
export const KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED =
  "KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED";

/**
 * Result returned by `resolveDefaultKmsKeyForApply`. Extends the Wave
 * C `ResolveDefaultKmsKeyResult` shape with the resolved `accountId`
 * so downstream debugging / log-correlation can see exactly which
 * account the CMK was minted for.
 */
export interface ApplyTimeKmsResult extends ResolveDefaultKmsKeyResult {
  /** The 12-digit AWS account id used as the alias-resolver cache key. */
  accountId: string;
}

/**
 * Options for {@link resolveDefaultKmsKeyForApply}.
 */
export interface ResolveDefaultKmsKeyForApplyOptions {
  /** AWS region — alias-resolver cache slot + KMS client binding. */
  region: string;
  /**
   * Pre-constructed KMS client. When omitted the helper constructs one
   * (cached per region for the lifetime of the process) using
   * operator credentials.
   */
  kms?: KMSClient;
  /**
   * Reserved for future SaaS multi-tenant credential resolution. Not
   * used on the foundation path; accepted so plugins in D-1…D-8 don't
   * need a signature change when SaaS lands.
   */
  configPort?: ConfigPort;
  /**
   * If supplied, bypasses STS GetCallerIdentity entirely. Used by
   * tests and by the future SaaS worker that already knows the
   * tenant's accountId from an upstream session token.
   */
  accountIdOverride?: string;
  /**
   * TenantId for the existing `getOperatorAccountId` cache. Defaults
   * to the legacy single-tenant id (env-derived). SaaS callers will
   * pass a real `TenantId` here.
   */
  tenantId?: TenantId;
  /** Run id for audit-log + structured-log correlation. */
  runId?: string;
}

/**
 * Per-process cache: `region` → KMSClient. Plugins that don't pass
 * their own `kms` argument share one client per region, mirroring how
 * `resolve-arn.ts` shares one STSClient per process.
 *
 * Bound: a single apply-run typically touches 1-3 regions (compound
 * provisioning across regions is rare); the cache is therefore
 * effectively bounded by N_regions and never exceeds a handful of
 * entries in production. There is no automatic eviction — SaaS
 * multi-tenant workers MUST call
 * {@link clearApplyTimeKmsClientCache} between tenants to avoid
 * cross-tenant client reuse.
 *
 * Cleared at process exit (CLI is one-shot).
 */
const kmsClientByRegion = new Map<string, KMSClient>();

/**
 * Test-only / SaaS-multi-tenant helper. Resets the per-region KMS
 * client cache so the next call constructs a fresh client. Production
 * code should never invoke this — the cache is correct for the
 * lifetime of one CLI process.
 */
export function clearApplyTimeKmsClientCache(): void {
  kmsClientByRegion.clear();
}

/**
 * Resolve the default Assignee-managed CMK for the apply run.
 * Idempotent and per-process cached.
 *
 * Resolution order:
 *   1. If `accountIdOverride` is supplied, use it.
 *   2. Otherwise call `getOperatorAccountId(tenantId)` — this is
 *      the same helper `resolveResourceArn` uses, so two callers in
 *      the same process share one STS round-trip.
 *   3. If accountId resolution fails (missing creds, timeout,
 *      empty Account), throw `AssigneeError(KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED)`
 *      WITHOUT touching KMS — failing closed avoids minting a CMK in
 *      the wrong account.
 *   4. Construct (or reuse) a region-bound KMSClient.
 *   5. Delegate to `resolveOrCreateDefaultKmsKey({ kms, accountId,
 *      region, runId })`.
 *
 * @throws {AssigneeError} `KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED` when
 *   STS fails. Other `KMS_*` errors propagate from the underlying
 *   resolver unchanged.
 */
export async function resolveDefaultKmsKeyForApply(
  opts: ResolveDefaultKmsKeyForApplyOptions,
): Promise<ApplyTimeKmsResult> {
  // L4: `configPort` is reserved for SaaS multi-tenant credential
  // routing (see ResolveDefaultKmsKeyForApplyOptions docstring). The
  // Wave C `resolveOrCreateDefaultKmsKey` primitive does not accept it
  // today, so we cannot thread it through. Reference it explicitly so
  // a future strict-unused lint sweep doesn't strip the API parameter
  // before plugins in D-1…D-8 start passing it.
  void opts.configPort;
  const accountId = await resolveAccountId(opts);
  const kms = opts.kms ?? getOrCreateKmsClient(opts.region);
  const result = await resolveOrCreateDefaultKmsKey({
    kms,
    accountId,
    region: opts.region,
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  });
  return {
    ...result,
    accountId,
  };
}

/**
 * Internal: resolve accountId (override → STS → throw).
 *
 * Kept as its own function so the test suite can assert that
 * `accountIdOverride` short-circuits *before* any STS or KMS work
 * happens (AC-D0-5).
 */
async function resolveAccountId(
  opts: ResolveDefaultKmsKeyForApplyOptions,
): Promise<string> {
  if (opts.accountIdOverride !== undefined) {
    if (!opts.accountIdOverride.trim()) {
      throw new AssigneeError(
        `apply-time-kms-resolver: accountIdOverride is empty. Pass a 12-digit AWS account id or omit the field to fall back to STS.`,
        KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
      );
    }
    return opts.accountIdOverride;
  }

  let accountId: string | undefined;
  try {
    accountId = await getOperatorAccountId(opts.tenantId);
  } catch (err) {
    // getOperatorAccountId is documented to swallow internal errors and
    // return undefined; this catch is defence-in-depth in case that
    // contract changes (and so a hostile mock that throws still
    // surfaces a structured error here).
    const cause =
      err instanceof MissingAssigneeCredentialsError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    throw new AssigneeError(
      `apply-time-kms-resolver: STS GetCallerIdentity failed (${cause}). ` +
        `Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY are set, ` +
        `AWS_REGION is reachable, and STS is not throttling. ` +
        `Retry the apply once credentials are healthy, or pass accountIdOverride if you already know the tenant account id.`,
      KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
    );
  }

  if (!accountId) {
    throw new AssigneeError(
      `apply-time-kms-resolver: could not resolve operator account id via STS GetCallerIdentity. ` +
        `Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY are set, ` +
        `AWS_REGION is reachable, and STS is not throttling. ` +
        `Retry the apply once credentials are healthy, or pass accountIdOverride if you already know the tenant account id.`,
      KMS_DEFAULT_RESOLVE_ACCOUNT_FAILED,
    );
  }
  return accountId;
}

/**
 * Internal: lazy region-bound KMSClient construction with per-process
 * caching. The cache key is `region` so two regions in a multi-region
 * apply get distinct clients (each pinned to its own AWS endpoint).
 */
function getOrCreateKmsClient(region: string): KMSClient {
  const existing = kmsClientByRegion.get(region);
  if (existing) return existing;
  const creds = requireAssigneeCredentials("operator");
  const client = createKmsClient({
    region,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
  });
  kmsClientByRegion.set(region, client);
  return client;
}
