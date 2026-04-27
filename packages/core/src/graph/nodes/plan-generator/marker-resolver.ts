/**
 * Compound-marker resolution for plan-generator.
 *
 * Two modes, sharing marker-parse machinery:
 *   - `resolveCompoundMarkers` (async) — apply-mode: substitutes
 *     markers with real physical IDs from completed resources, real
 *     region string, and real AZ names from EC2 DescribeAvailabilityZones.
 *   - `resolvePlaceholderMarkers` (sync) — plan-mode: substitutes with
 *     human-readable placeholders like "(from vpc)" and deterministic
 *     AZ placeholders ("us-east-1a") — no AWS calls.
 */
import {
  createEC2Client,
  parseMarker,
  MARKER_PREFIX,
  MARKER_PATTERN_GLOBAL,
  type ResourceResult,
} from "@/index.js";
import { tryAssigneeCredentials } from "@/config/aws-credentials.js";
import { extractIdentifierFromArn } from "@/config/arn-helpers.js";
import {
  type TenantId,
  createLegacySingleTenantId,
} from "@/tenant/tenant-id.js";
import { TenantScopedCache } from "@/tenant/tenant-scoped-cache.js";

/**
 * Lookup function returning the sorted list of AvailabilityZone names for a
 * region. Abstracted so unit tests can substitute a deterministic fixture in
 * place of a real EC2 DescribeAvailabilityZones call. Narrow ISP/DIP port.
 */
export type AzLookup = (region: string) => Promise<string[]>;

/**
 * Lookup function returning the calling operator's AWS account ID.
 * Abstracted so unit tests can supply a deterministic account ID instead
 * of requiring real STS credentials for every fixture.
 */
export type AccountIdLookup = () => Promise<string>;

/**
 * Default AZ lookup — dynamically imports the EC2 SDK and calls
 * DescribeAvailabilityZones with operator credentials. Results are cached per
 * region for the lifetime of the process; compound plan generation may need
 * multiple AZs within a single run and we don't want to pay for the SDK
 * round-trip more than once.
 */
/**
 * Default account-ID lookup — calls STS GetCallerIdentity once per
 * tenant and caches. Used when no `accountIdLookup` is supplied via
 * resolver options (production path). Unit tests supply a deterministic
 * lookup so they don't need STS credentials.
 *
 * MASTER-008 (RW4a): the cache is now keyed per-tenant. Previously a
 * single module-level `ACCOUNT_ID_CACHE` returned tenant A's account
 * to tenant B in a multi-tenant SaaS worker.
 */
const accountIdCache = new TenantScopedCache<string>();
export function __resetAccountIdCacheForTests(): void {
  accountIdCache.clear();
}
export function defaultAccountIdLookup(
  region: string,
  tenantId?: TenantId,
): AccountIdLookup {
  // TODO(SaaS): make tenantId required once `resolveCompoundMarkers` callers
  // thread it through from graph state instead of falling back to env vars.
  const tid = tenantId ?? { ...createLegacySingleTenantId(), region };
  return async () => {
    const cached = accountIdCache.get(tid);
    if (cached) return cached;
    const { STSClient, GetCallerIdentityCommand } =
      await import("@aws-sdk/client-sts");
    const creds = tryAssigneeCredentials("operator");
    if (!creds) {
      throw new Error(
        "ACCOUNT_ID marker resolution requires operator credentials " +
          "(ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY). " +
          "None set.",
      );
    }
    const sts = new STSClient({ region, credentials: creds });
    try {
      const res = await sts.send(new GetCallerIdentityCommand({}));
      if (!res.Account) {
        throw new Error("STS GetCallerIdentity returned no Account.");
      }
      accountIdCache.set(tid, res.Account);
      return res.Account;
    } finally {
      sts.destroy();
    }
  };
}

/**
 * Per-tenant region→AZ-list cache. AZ names are stable per (account,
 * region) pair — different accounts may have different AZ visibility
 * because of opt-in regions and per-account AZ name mapping
 * (`use1-az1` for tenant A and tenant B map to physically different
 * AZs even when the public name `us-east-1a` is identical). Scoping
 * by tenant therefore matters even though the public name string
 * usually matches.
 */
const azCache = new TenantScopedCache<Map<string, string[]>>();

function getOrCreateAzMap(tenantId: TenantId): Map<string, string[]> {
  let map = azCache.get(tenantId);
  if (!map) {
    map = new Map<string, string[]>();
    azCache.set(tenantId, map);
  }
  return map;
}

export async function defaultAzLookup(
  region: string,
  tenantId?: TenantId,
): Promise<string[]> {
  // TODO(SaaS): make tenantId required once `resolveCompoundMarkers`
  // threads it through from graph state.
  const tid = tenantId ?? { ...createLegacySingleTenantId(), region };
  const tenantMap = getOrCreateAzMap(tid);
  const cached = tenantMap.get(region);
  if (cached) return cached;
  const operatorCreds = tryAssigneeCredentials("operator");
  if (!operatorCreds) {
    throw new Error(
      `Cannot resolve AvailabilityZone markers: operator credentials missing. ` +
        `Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY.`,
    );
  }
  const { DescribeAvailabilityZonesCommand } =
    await import("@aws-sdk/client-ec2");
  const ec2 = createEC2Client({ region, credentials: operatorCreds });
  try {
    const result = await ec2.send(
      new DescribeAvailabilityZonesCommand({
        Filters: [{ Name: "state", Values: ["available"] }],
      }),
    );
    const zones = (result.AvailabilityZones ?? [])
      .map((z) => z.ZoneName)
      .filter((z): z is string => typeof z === "string" && z.length > 0)
      .sort();
    if (zones.length === 0) {
      throw new Error(
        `DescribeAvailabilityZones returned no zones for region "${region}".`,
      );
    }
    tenantMap.set(region, zones);
    return zones;
  } finally {
    ec2.destroy();
  }
}

/** Test-only hook: clears the per-tenant region→AZ cache so fixtures don't leak between tests. */
export function __resetAzCacheForTests(): void {
  azCache.clear();
}

/**
 * Plan-mode placeholder resolution: replaces compound markers with
 * human-readable placeholders for display. Unlike `resolveCompoundMarkers`,
 * this does NOT need AWS credentials or completed resources — it produces
 * display-only strings like "(from vpc)" or "us-east-1a".
 *
 * Mutates `desiredState` in place.
 */
export function resolvePlaceholderMarkers(
  desiredState: Record<string, unknown>,
  region: string,
): void {
  function azPlaceholder(index: number): string {
    return `${region}${String.fromCharCode(97 + index)}`;
  }

  function resolveValue(value: string): string {
    // Fast path: entire string is a single marker
    const parsed = parseMarker(value);
    if (parsed) {
      return resolveSinglePlaceholder(parsed);
    }
    // Embedded markers: replace each token in the string.
    if (!value.includes(MARKER_PREFIX)) return value;
    // Per-call RegExp — shared stateful regexes trip up concurrent callers.
    const markerRegex = new RegExp(
      MARKER_PATTERN_GLOBAL.source,
      MARKER_PATTERN_GLOBAL.flags,
    );
    return value.replace(markerRegex, (token) => {
      const p = parseMarker(token);
      return p ? resolveSinglePlaceholder(p) : token;
    });
  }

  function resolveSinglePlaceholder(
    parsed: NonNullable<ReturnType<typeof parseMarker>>,
  ): string {
    if (
      parsed.kind === "ref" ||
      parsed.kind === "getatt" ||
      parsed.kind === "identifier"
    ) {
      return `(from ${parsed.resourceId})`;
    }
    if (parsed.kind === "region") {
      return region;
    }
    if (parsed.kind === "account-id") {
      return "(account)";
    }
    return azPlaceholder(parsed.index);
  }

  function walk(obj: unknown): unknown {
    if (typeof obj === "string") {
      return resolveValue(obj);
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        obj[i] = walk(obj[i]);
      }
      return obj;
    }
    if (obj && typeof obj === "object") {
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        (obj as Record<string, unknown>)[key] = walk(value);
      }
      return obj;
    }
    return obj;
  }

  walk(desiredState);
}

/**
 * Walks `desiredState` recursively and substitutes every marker-token string
 * with the concrete value it represents:
 *
 * - `__ASSIGNEE_REF_<id>__`    → physical ID from `completedResources` (resourceArn)
 * - `__ASSIGNEE_GETATT_<id>_<attr>__` → physical ID from `completedResources`
 *                                   (CloudControl only returns the primary
 *                                   identifier, which is what downstream
 *                                   resources actually need)
 * - `__ASSIGNEE_AZ_<n>__`      → Nth AvailabilityZone name in `region`
 *
 * Fails fast with a descriptive error when a REF target is missing, so
 * dependency-order bugs surface at plan time instead of producing a malformed
 * CloudControl request.
 *
 * Mutates `desiredState` in place (and returns it) for ergonomic chaining.
 */
export async function resolveCompoundMarkers(
  desiredState: Record<string, unknown>,
  options: {
    completedResources: readonly ResourceResult[];
    region: string;
    currentResourceId: string;
    azLookup?: AzLookup;
    accountIdLookup?: AccountIdLookup;
  },
): Promise<Record<string, unknown>> {
  const lookup = options.azLookup ?? defaultAzLookup;
  const accountIdLookup =
    options.accountIdLookup ?? defaultAccountIdLookup(options.region);
  let azCache: string[] | undefined;
  let accountIdCache: string | undefined;

  async function resolveString(value: string, path: string): Promise<string> {
    // Fast path: entire string is a single marker
    const parsed = parseMarker(value);
    if (parsed) {
      return resolveSingleMarker(parsed, path);
    }
    if (!value.includes(MARKER_PREFIX)) return value;
    // Per-call RegExp: exec() advances lastIndex, so each invocation needs
    // its own instance to avoid cross-call state leaks.
    const markerRegex = new RegExp(
      MARKER_PATTERN_GLOBAL.source,
      MARKER_PATTERN_GLOBAL.flags,
    );
    let result = value;
    let match: RegExpExecArray | null;
    // Collect all matches first (avoid mutating during iteration)
    const matches: Array<{
      token: string;
      parsed: NonNullable<ReturnType<typeof parseMarker>>;
    }> = [];
    while ((match = markerRegex.exec(value)) !== null) {
      const token = match[0];
      const p = parseMarker(token);
      if (p) matches.push({ token, parsed: p });
    }
    for (const m of matches) {
      const resolved = await resolveSingleMarker(m.parsed, path);
      result = result.replace(m.token, resolved);
    }
    return result;
  }

  async function resolveSingleMarker(
    parsed: NonNullable<ReturnType<typeof parseMarker>>,
    path: string,
  ): Promise<string> {
    if (
      parsed.kind === "ref" ||
      parsed.kind === "getatt" ||
      parsed.kind === "identifier"
    ) {
      const match = options.completedResources.find(
        (r) => r.resourceId === parsed.resourceId,
      );
      if (!match) {
        throw new Error(
          `Compound marker resolution failed at "${path}" for resource ` +
            `"${options.currentResourceId}": no completed resource with ` +
            `resourceId "${parsed.resourceId}" found. ` +
            `Check the pattern's dependencyOrder — the referenced resource ` +
            `must be provisioned before "${options.currentResourceId}".`,
        );
      }
      if (!match.resourceArn) {
        throw new Error(
          `Compound marker resolution failed at "${path}" for resource ` +
            `"${options.currentResourceId}": dependency "${parsed.resourceId}" ` +
            `completed without a physical identifier (resourceArn undefined). ` +
            `This is a CloudControl adapter bug — please file an issue.`,
        );
      }
      const fullArn = String(match.resourceArn);
      // `identifier` markers return the BARE primary identifier (bucket name,
      // vpc-id, instance-id, …), NOT the ARN. See markerIdentifier JSDoc and
      // the S3 BucketPolicy.Bucket field in static-website pattern — that
      // property requires the bucket name, not the ARN. `ref`/`getatt` keep
      // the historical ARN behaviour.
      if (parsed.kind === "identifier") {
        return extractIdentifierFromArn(fullArn);
      }
      return fullArn;
    }
    // Region marker — resolves to the target AWS region string
    if (parsed.kind === "region") {
      return options.region;
    }
    // Account-ID marker — one STS call per plan, cached.
    if (parsed.kind === "account-id") {
      if (!accountIdCache) {
        accountIdCache = await accountIdLookup();
      }
      return accountIdCache;
    }
    // AZ marker
    if (!azCache) {
      azCache = await lookup(options.region);
    }
    const zone = azCache[parsed.index];
    if (!zone) {
      throw new Error(
        `Compound marker resolution failed at "${path}" for resource ` +
          `"${options.currentResourceId}": AZ index ${parsed.index} is out ` +
          `of range — region "${options.region}" only has ${azCache.length} ` +
          `availability zones (${azCache.join(", ")}).`,
      );
    }
    return zone;
  }

  async function walk(value: unknown, path: string): Promise<unknown> {
    if (typeof value === "string") {
      return resolveString(value, path);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        out.push(await walk(value[i], `${path}[${i}]`));
      }
      return out;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await walk(v, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return value;
  }

  const resolved = (await walk(desiredState, "")) as Record<string, unknown>;
  // Mutate in place for the caller's convenience — keep reference stability.
  for (const k of Object.keys(desiredState)) delete desiredState[k];
  Object.assign(desiredState, resolved);
  return desiredState;
}
