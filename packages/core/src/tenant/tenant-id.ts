/**
 * TenantId — opaque identity for a single AWS-account/region/role tuple.
 *
 * MASTER-008 (RW4a): the core graph nodes used to keep five module-level
 * mutable singletons that cached BP rules, account IDs, free-tier config,
 * and EC2 instance-type catalogues for the lifetime of the process. Run
 * inside a multi-tenant SaaS worker, those caches leak the first tenant's
 * data into every subsequent tenant's request because the cache key is
 * "process" — not "who is asking".
 *
 * This module introduces a stable identity object that callers thread
 * through to the cache layer. Each cache is now keyed on `tenantIdToKey`
 * so two different tenants never share a cache slot.
 *
 * # Identity definition
 *
 * A TenantId is the (accountId, region, optional roleArn) tuple that
 * uniquely identifies who the AWS SDK calls will run as:
 *
 * - `accountId` — the 12-digit AWS account number that owns the
 *   resources being managed. Resolved from `sts:GetCallerIdentity`
 *   (production) or supplied explicitly by tests.
 * - `region` — the AWS region the request is running against
 *   (us-east-1, us-iso-east-1, eu-central-2, …). Two requests against
 *   the same account but different regions are distinct tenants
 *   because instance-type availability, AZ names, and free-tier status
 *   all differ.
 * - `roleArn` — optional cross-account role the request assumed
 *   into. Two principals from the same workload identity that
 *   assume into two different target accounts must NOT share cached
 *   account IDs (different STS responses).
 *
 * # Lifetime
 *
 * A TenantId is stable for the lifetime of a single graph
 * invocation. It is created at graph construction and threaded down
 * through state. Callers MUST NOT mutate the object — treat it as
 * `Readonly`.
 *
 * # Migration path
 *
 * The five cache sites this PR converts (rule-loader, marker-resolver,
 * free-tier, resolve-arn, ec2-instance-types) currently take no
 * tenantId argument because graph state passes credential/region info
 * implicitly via env vars. To stay backwards compatible during the
 * migration, the cache helpers accept an optional `tenantId`
 * parameter; when omitted they fall back to
 * {@link createLegacySingleTenantId} which derives identity from
 * `process.env.AWS_ACCOUNT_ID` / `process.env.AWS_REGION`. This is
 * single-tenant-only — the ` // TODO(SaaS): replace with caller-passed
 * TenantId` comment at each call site marks where the legacy fallback
 * needs to be replaced when the caller-side migration lands.
 */

/**
 * Stable identity of an AWS-account/region/role tuple. Treat as
 * immutable — every cache site is keyed on the canonical string from
 * {@link tenantIdToKey}, and mutating a TenantId mid-flight produces
 * stale lookups.
 */
export interface TenantId {
  readonly accountId: string;
  readonly region: string;
  readonly roleArn?: string;
}

/**
 * Canonical string-key derivation for {@link TenantScopedCache}.
 *
 * Format: `<accountId>|<region>|<roleArn ?? "">`.
 *
 * The empty trailing segment for "no role assumed" is intentional —
 * it keeps the key shape constant so a caller that later starts
 * supplying a roleArn does NOT clobber the cache slot for the
 * non-roleArn case.
 */
export function tenantIdToKey(t: TenantId): string {
  return `${t.accountId}|${t.region}|${t.roleArn ?? ""}`;
}

/**
 * Default placeholder accountId for the single-tenant legacy fallback
 * when `AWS_ACCOUNT_ID` is not set in the environment. Twelve zeros
 * is documented as a reserved test value (see
 * {@link feedback_no_real_account_ids_in_repo}) and never overlaps a
 * real AWS account number.
 */
const LEGACY_PLACEHOLDER_ACCOUNT_ID = "000000000000";

/**
 * Default region for the single-tenant legacy fallback when
 * `AWS_REGION` is unset. Matches the SDK's documented default.
 */
const LEGACY_DEFAULT_REGION = "us-east-1";

/**
 * Backwards-compatibility helper for the cache sites that don't yet
 * thread a TenantId through their call chain.
 *
 * Single-tenant CLI mode: the entire process speaks to ONE AWS
 * account, so reading `AWS_ACCOUNT_ID` / `AWS_REGION` from env is
 * safe. For the multi-tenant SaaS worker case, callers MUST stop
 * relying on this and pass an explicit `tenantId`.
 *
 * Returns a fresh object each call — do not memoize the result; the
 * env vars can change between graph invocations in long-running
 * processes (Lambda warm starts, test runners that mutate env in
 * `beforeEach`).
 */
export function createLegacySingleTenantId(): TenantId {
  return {
    accountId: process.env["AWS_ACCOUNT_ID"] ?? LEGACY_PLACEHOLDER_ACCOUNT_ID,
    region: process.env["AWS_REGION"] ?? LEGACY_DEFAULT_REGION,
  };
}
