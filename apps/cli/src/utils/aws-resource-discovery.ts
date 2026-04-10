/**
 * AWS resource discovery for dynamic option elicitation.
 * Fetches real VPCs, subnets, security groups, key pairs, and AMIs
 * from the user's AWS account using the READER credential set.
 *
 * Each function has a 6-second timeout and returns [] on failure.
 * Results are cached per-session to avoid redundant API calls.
 *
 * @see Story 7.11
 */

import {
  EC2Client,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeKeyPairsCommand,
  DescribeInstanceTypesCommand,
  DescribeImagesCommand,
  type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import {
  RDSClient,
  DescribeDBEngineVersionsCommand,
  DescribeOrderableDBInstanceOptionsCommand,
} from "@aws-sdk/client-rds";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  CfnKey,
  ResourceDefault,
  AmiOs,
  DiscoveryCacheKey,
  lambdaRuntimes,
} from "@assignee/core";
import { withTimeout } from "./timeout.js";
import { AWS_REGION, PromiseStatus } from "../config/constants.js";
import {
  tryAssigneeCredentials,
  type ExplicitAwsCredentials,
} from "../config/aws-credentials.js";
import { WorkloadProfile as WP } from "../constants/workload-profiles.js";

const DISCOVERY_TIMEOUT_MS = 6000;

/** Option shape compatible with ResourceField question options. */
export interface DiscoveryOption {
  value: string;
  label: string;
}

// ── Session cache ────────────────────────────────────────────────────────────

/** Cache entry with TTL support. */
interface CacheEntry {
  data: DiscoveryOption[];
  fetchedAt: number;
  ttl: number;
}

/** Default TTL: 5 minutes. */
const DEFAULT_TTL_MS = 300_000;

// Re-export DiscoveryCacheKey from core for consumers that import from this module
export { DiscoveryCacheKey } from "@assignee/core";

/** Per-fetcher TTL overrides (milliseconds). */
const FETCHER_TTL: Record<string, number> = {
  [DiscoveryCacheKey.AMIS]: 120_000, // 2 min
  [DiscoveryCacheKey.SUBNETS]: 120_000, // 2 min
  [DiscoveryCacheKey.KEY_PAIRS]: 120_000, // 2 min
  [DiscoveryCacheKey.SECURITY_GROUPS]: 120_000, // 2 min
  [DiscoveryCacheKey.RDS_ENGINE_VERSIONS]: 300_000, // 5 min
  [DiscoveryCacheKey.RDS_INSTANCE_CLASSES]: 300_000, // 5 min
  [DiscoveryCacheKey.LAMBDA_RUNTIMES]: 900_000, // 15 min
};

const discoveryCache = new Map<string, CacheEntry>();

/** Reset cache — used by tests and when region changes. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

async function cachedDiscover(
  key: string,
  fetcher: () => Promise<DiscoveryOption[]>,
): Promise<DiscoveryOption[]> {
  const entry = discoveryCache.get(key);
  if (entry) {
    const age = Date.now() - entry.fetchedAt;
    if (age < entry.ttl) {
      return entry.data;
    }
    // Expired — remove stale entry
    discoveryCache.delete(key);
  }

  try {
    const results = await fetcher();
    if (results.length > 0) {
      const ttl = FETCHER_TTL[key] ?? DEFAULT_TTL_MS;
      discoveryCache.set(key, { data: results, fetchedAt: Date.now(), ttl });
    }
    return results;
  } catch {
    // Discovery is best-effort — callers fall back to manual entry.
    return [];
  }
}

// ── Shared client factory ────────────────────────────────────────────────────

/**
 * Resolve reader credentials via the centralized helper.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * GRACEFUL DEGRADATION CONTRACT
 * ──────────────────────────────────────────────────────────────────────────
 * Discovery is a best-effort, read-only feature used by the option-elicitor
 * to populate dropdowns (subnets, AMIs, key pairs, RDS classes, etc.). A user
 * running `assignee plan` with only operator credentials configured — but no
 * reader credentials — must still be able to run the wizard with manual-entry
 * fallbacks. We therefore use `tryAssigneeCredentials` (non-throwing) and
 * return `undefined` so each discover*() function can short-circuit to `[]`
 * before ever constructing an SDK client.
 *
 * SECURITY: never falls through to `~/.aws/credentials`, SSO, or IMDS. When
 * reader env vars are unset, the SDK client is simply not built — no empty
 * credentials are ever sent to AWS, and no ambient AWS_* shell vars are
 * honored.
 */
function readerCredsOrUndefined(): ExplicitAwsCredentials | undefined {
  return tryAssigneeCredentials("reader");
}

function createEc2Client(): EC2Client | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new EC2Client({
    region: AWS_REGION,
    credentials: creds,
  });
}

function createSsmClient(): SSMClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new SSMClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

function createRdsClient(): RDSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new RDSClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

/** Categorized instance type for the two-step category select. */
export interface InstanceTypeCategory {
  key: string;
  label: string;
  description: string;
  options: DiscoveryOption[];
}

/** Maps EC2 instance family prefix to a user-friendly category. */
function categorizeFamily(family: string): {
  key: string;
  label: string;
  description: string;
} {
  const prefix = family.toLowerCase();
  if (prefix.startsWith("t"))
    return {
      key: WP.BURSTABLE,
      label: "Burstable",
      description: "Dev, small production, variable workloads",
    };
  if (prefix.startsWith("m"))
    return {
      key: WP.GENERAL,
      label: "General Purpose",
      description: "Balanced compute, memory, networking",
    };
  if (prefix.startsWith("c"))
    return {
      key: WP.COMPUTE,
      label: "Compute Optimized",
      description: "Batch, HPC, gaming, ML inference",
    };
  if (prefix.startsWith("r") || prefix.startsWith("x"))
    return {
      key: WP.MEMORY,
      label: "Memory Optimized",
      description: "Databases, caches, in-memory analytics",
    };
  if (
    prefix.startsWith("p") ||
    prefix.startsWith("g") ||
    prefix.startsWith("inf") ||
    prefix.startsWith("trn")
  )
    return {
      key: WP.ACCELERATED,
      label: "GPU / Accelerated",
      description: "ML training, inference, graphics, video",
    };
  if (
    prefix.startsWith("i") ||
    prefix.startsWith("d") ||
    prefix.startsWith("h")
  )
    return {
      key: WP.STORAGE,
      label: "Storage Optimized",
      description: "High I/O, data warehousing, distributed filesystems",
    };
  if (prefix.startsWith("hpc"))
    return {
      key: WP.HPC,
      label: "HPC",
      description: "High-performance computing",
    };
  if (prefix.startsWith("a"))
    return {
      key: WP.ARM,
      label: "ARM (Graviton 1st gen)",
      description: "ARM workloads, lowest cost",
    };
  return { key: WP.OTHER, label: "Other", description: prefix };
}

/**
 * Discovers available EC2 instance types from the account's region.
 * Groups them by family category for the two-step category select.
 * Returns [] on failure — caller falls back to hardcoded categories.
 */
let instanceTypeCache: InstanceTypeCategory[] | null = null;

export async function discoverInstanceTypes(): Promise<InstanceTypeCategory[]> {
  if (instanceTypeCache) return instanceTypeCache;

  try {
    const categories = await (async () => {
      const ec2 = createEc2Client();
      if (!ec2) return []; // Graceful no-op: reader creds not configured

      // Fetch common instance types (filter to current-gen to keep list manageable)
      const result = await withTimeout(
        ec2.send(
          new DescribeInstanceTypesCommand({
            Filters: [{ Name: "current-generation", Values: ["true"] }],
            MaxResults: 500,
          }),
        ),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!result?.InstanceTypes) return [];

      // Group by category
      const categoryMap = new Map<
        string,
        { meta: ReturnType<typeof categorizeFamily>; types: InstanceTypeInfo[] }
      >();

      for (const it of result.InstanceTypes) {
        if (!it.InstanceType) continue;
        const family = it.InstanceType.split(".")[0] ?? "";
        const meta = categorizeFamily(family);

        let entry = categoryMap.get(meta.key);
        if (!entry) {
          entry = { meta, types: [] };
          categoryMap.set(meta.key, entry);
        }
        entry.types.push(it);
      }

      // Sort types within each category by vCPU then memory
      const categories: InstanceTypeCategory[] = [];
      // Preferred category order
      const order = [
        WP.BURSTABLE,
        WP.GENERAL,
        WP.COMPUTE,
        WP.MEMORY,
        WP.ACCELERATED,
        WP.STORAGE,
        WP.HPC,
        WP.ARM,
        WP.OTHER,
      ];

      for (const key of order) {
        const entry = categoryMap.get(key);
        if (!entry) continue;

        entry.types.sort((a, b) => {
          const vcpuDiff =
            (a.VCpuInfo?.DefaultVCpus ?? 0) - (b.VCpuInfo?.DefaultVCpus ?? 0);
          if (vcpuDiff !== 0) return vcpuDiff;
          return (
            (a.MemoryInfo?.SizeInMiB ?? 0) - (b.MemoryInfo?.SizeInMiB ?? 0)
          );
        });

        const options: DiscoveryOption[] = entry.types.map((it) => {
          const vcpu = it.VCpuInfo?.DefaultVCpus ?? "?";
          const memMiB = it.MemoryInfo?.SizeInMiB ?? 0;
          const memGiB =
            memMiB >= 1024
              ? `${(memMiB / 1024).toFixed(0)} GiB`
              : `${memMiB} MiB`;
          const gpu = it.GpuInfo?.Gpus?.[0];
          const gpuLabel = gpu ? ` ${gpu.Count}x ${gpu.Name ?? "GPU"}` : "";
          return {
            value: it.InstanceType!,
            label: `${it.InstanceType} (${vcpu} vCPU, ${memGiB}${gpuLabel})`,
          };
        });

        categories.push({
          key: entry.meta.key,
          label: `${entry.meta.label} (${options.length} types)`,
          description: entry.meta.description,
          options,
        });
      }

      return categories;
    })();

    if (categories.length > 0) {
      instanceTypeCache = categories;
    }
    return categories;
  } catch {
    return [];
  }
}

// ── Discovery functions ──────────────────────────────────────────────────────

/**
 * Discovers latest AMIs via SSM public parameters.
 * Fetches Amazon Linux 2023, Ubuntu 22.04, Ubuntu 24.04, Windows Server 2022.
 */
export async function discoverAmis(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.AMIS, async () => {
    const ssm = createSsmClient();
    if (!ssm) return []; // Graceful no-op: reader creds not configured
    const params: Array<{ path: string; label: string }> = [
      {
        path: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        label: "Amazon Linux 2023",
      },
      {
        path: "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
        label: "Ubuntu 22.04 LTS",
      },
      {
        path: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
        label: "Ubuntu 24.04 LTS",
      },
      {
        path: "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base",
        label: "Windows Server 2022",
      },
    ];

    const results = await Promise.allSettled(
      params.map(async ({ path, label }) => {
        const result = await withTimeout(
          ssm.send(new GetParameterCommand({ Name: path })),
          DISCOVERY_TIMEOUT_MS,
        );
        if (!result?.Parameter?.Value) return null;
        const amiId = result.Parameter.Value;
        return { value: amiId, label: `${label} (${amiId})` };
      }),
    );

    const options: DiscoveryOption[] = [];
    for (const r of results) {
      if (r.status === PromiseStatus.FULFILLED && r.value) {
        options.push(r.value);
      }
    }
    return options;
  });
}

/**
 * OS name → SSM parameter path mapping for AMI resolution.
 * Used when the user picks an OS from the static fallback menu
 * instead of a real AMI ID (discovery failed).
 */
const OS_TO_SSM_PATH: Record<string, string> = {
  [AmiOs.AMAZON_LINUX_2023]:
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  [AmiOs.UBUNTU_24]:
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
  [AmiOs.UBUNTU_22]:
    "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
  [AmiOs.WINDOWS_2022]:
    "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base",
};

/**
 * Resolves an OS name (e.g., "amazon-linux-2023") to a real AMI ID
 * via a targeted SSM parameter lookup. Returns null on failure.
 */
export async function resolveAmiFromOsName(
  osName: string,
): Promise<string | null> {
  const ssmPath = OS_TO_SSM_PATH[osName];
  if (!ssmPath) return null;

  try {
    const ssm = createSsmClient();
    if (!ssm) return null; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ssm.send(new GetParameterCommand({ Name: ssmPath })),
      DISCOVERY_TIMEOUT_MS,
    );
    return result?.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/**
 * Discovers VPC subnets from the account.
 * Shows Name tag, CIDR block, and availability zone.
 */
export async function discoverSubnets(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.SUBNETS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ec2.send(new DescribeSubnetsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.Subnets) return [];

    return result.Subnets.map((subnet) => {
      const nameTag = subnet.Tags?.find((t) => t.Key === "Name")?.Value;
      const label = nameTag
        ? `${nameTag} (${subnet.CidrBlock}, ${subnet.AvailabilityZone}) — ${subnet.SubnetId}`
        : `${subnet.SubnetId} (${subnet.CidrBlock}, ${subnet.AvailabilityZone})`;
      return { value: subnet.SubnetId!, label };
    }).filter((o) => o.value);
  });
}

/**
 * Discovers security groups from the account.
 * Shows group name and description.
 */
export async function discoverSecurityGroups(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.SECURITY_GROUPS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ec2.send(new DescribeSecurityGroupsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    // Prepend "None" option — VPC default SG is used when no SG is selected
    const options: DiscoveryOption[] = [
      { value: "", label: "None (use VPC default security group)" },
    ];
    if (!result?.SecurityGroups) return options;

    for (const sg of result.SecurityGroups) {
      if (sg.GroupName === "default" || !sg.GroupId) continue;
      const desc =
        sg.Description && sg.Description !== sg.GroupName
          ? ` — ${sg.Description}`
          : "";
      options.push({
        value: sg.GroupId,
        label: `${sg.GroupName}${desc} (${sg.GroupId})`,
      });
    }
    return options;
  });
}

/**
 * Discovers EC2 key pairs from the account.
 * Prepends a "None (SSM access only)" option.
 */
export async function discoverKeyPairs(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.KEY_PAIRS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ec2.send(new DescribeKeyPairsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.KeyPairs) return [];

    const options: DiscoveryOption[] = [
      { value: "", label: "None (SSM access only)" },
    ];
    for (const kp of result.KeyPairs) {
      if (kp.KeyName) {
        const keyType = kp.KeyType ?? "unknown";
        options.push({
          value: kp.KeyName,
          label: `${kp.KeyName} (${keyType})`,
        });
      }
    }
    return options;
  });
}

/**
 * Discovers available RDS engine versions for a given engine using
 * the DescribeDBEngineVersions API. Returns versions sorted newest-first.
 * The latest version is marked with `recommended: true`.
 *
 * @param context - Optional context object; expects `Engine` key (defaults to "postgres")
 */
export async function discoverRdsEngineVersions(
  context?: Record<string, unknown>,
): Promise<DiscoveryOption[]> {
  const engine =
    (context?.[CfnKey.ENGINE] as string) ?? ResourceDefault.RDS_ENGINE_POSTGRES;
  const cacheKey = `${DiscoveryCacheKey.RDS_ENGINE_VERSIONS}-${engine}`;

  return cachedDiscover(cacheKey, async () => {
    const rds = createRdsClient();
    if (!rds) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      rds.send(
        new DescribeDBEngineVersionsCommand({
          Engine: engine,
          DefaultOnly: false,
        }),
      ),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.DBEngineVersions) return [];

    // Collect unique versions, sorted newest-first
    const versions = result.DBEngineVersions.filter((v) => v.EngineVersion).map(
      (v) => ({
        version: v.EngineVersion!,
        description: v.DBEngineVersionDescription ?? v.EngineVersion!,
      }),
    );

    // Sort newest version first (descending)
    versions.sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    );

    // Deduplicate by version string
    const seen = new Set<string>();
    const unique = versions.filter((v) => {
      if (seen.has(v.version)) return false;
      seen.add(v.version);
      return true;
    });

    return unique.map((v, i) => ({
      value: v.version,
      label: v.description,
      ...(i === 0 ? { recommended: true } : {}),
    }));
  });
}

/**
 * Discovers available RDS instance classes for a given engine using
 * the DescribeOrderableDBInstanceOptions API. Returns deduplicated classes
 * grouped by family: burstable (db.t*), general (db.m*), memory (db.r*), other.
 * Sorted burstable-first (cheapest), then general, then memory, then other.
 *
 * @param context - Optional context object; expects `Engine` key (defaults to "postgres")
 */
export async function discoverRdsInstanceClasses(
  context?: Record<string, unknown>,
): Promise<DiscoveryOption[]> {
  const engine =
    (context?.[CfnKey.ENGINE] as string) ?? ResourceDefault.RDS_ENGINE_POSTGRES;
  const cacheKey = `${DiscoveryCacheKey.RDS_INSTANCE_CLASSES}-${engine}`;

  return cachedDiscover(cacheKey, async () => {
    const rds = createRdsClient();
    if (!rds) return []; // Graceful no-op: reader creds not configured

    // The API paginates — collect all pages
    const allClasses = new Set<string>();
    let marker: string | undefined;

    do {
      const result = await withTimeout(
        rds.send(
          new DescribeOrderableDBInstanceOptionsCommand({
            Engine: engine,
            ...(marker ? { Marker: marker } : {}),
          }),
        ),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!result?.OrderableDBInstanceOptions) break;

      for (const opt of result.OrderableDBInstanceOptions) {
        if (opt.DBInstanceClass) {
          allClasses.add(opt.DBInstanceClass);
        }
      }

      marker = result.Marker;
    } while (marker);

    if (allClasses.size === 0) return [];

    // Group by family
    const familyOrder: Record<string, number> = {
      [WP.BURSTABLE]: 0,
      [WP.GENERAL]: 1,
      [WP.MEMORY]: 2,
      [WP.OTHER]: 3,
    };

    function classifyRdsFamily(cls: string): string {
      // cls is like "db.t3.micro", "db.m5.large", "db.r6g.large"
      const parts = cls.split(".");
      const familyPrefix = parts[1]?.[0]?.toLowerCase() ?? "";
      if (familyPrefix === "t") return WP.BURSTABLE;
      if (familyPrefix === "m") return WP.GENERAL;
      if (familyPrefix === "r" || familyPrefix === "x") return WP.MEMORY;
      return WP.OTHER;
    }

    const sorted = [...allClasses].sort((a, b) => {
      const famA = familyOrder[classifyRdsFamily(a)] ?? 3;
      const famB = familyOrder[classifyRdsFamily(b)] ?? 3;
      if (famA !== famB) return famA - famB;
      // Within same family, sort alphabetically (which approximates size order)
      return a.localeCompare(b, undefined, { numeric: true });
    });

    return sorted.map((cls) => ({
      value: cls,
      label: cls,
    }));
  });
}

/**
 * Searches for AMIs matching a user description (e.g., "deep learning", "ML training").
 * Uses ec2:DescribeImages filtered to Amazon-owned, available, public images.
 * Returns top 5 results as DiscoveryOption[]. Cached per query string.
 */
export async function searchAmis(query: string): Promise<DiscoveryOption[]> {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];

  const cacheKey = `search-amis-${normalizedQuery}`;
  return cachedDiscover(cacheKey, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured

    // Build wildcard pattern from query words: "ML training" → "*ml*training*"
    const words = normalizedQuery.split(/\s+/).filter(Boolean);
    const namePattern = `*${words.join("*")}*`;

    const result = await withTimeout(
      ec2.send(
        new DescribeImagesCommand({
          Filters: [
            { Name: "name", Values: [namePattern] },
            { Name: "state", Values: ["available"] },
            { Name: "is-public", Values: ["true"] },
          ],
          Owners: ["amazon"],
        }),
      ),
      DISCOVERY_TIMEOUT_MS,
    );

    if (!result?.Images || result.Images.length === 0) return [];

    // Sort by creation date (newest first) and take top 5
    const sorted = result.Images.sort((a, b) => {
      const dateA = a.CreationDate ?? "";
      const dateB = b.CreationDate ?? "";
      return dateB.localeCompare(dateA);
    }).slice(0, 5);

    return sorted
      .filter((img) => img.ImageId)
      .map((img) => ({
        value: img.ImageId!,
        label: `${img.Name ?? "Unnamed AMI"} \u2014 ${img.ImageId}`,
      }));
  });
}

// ── Lambda runtimes (Story 44.4) ─────────────────────────────────────────

/**
 * Returns the canonical Lambda runtime list for the fetcher system.
 *
 * AWS does not expose a ListRuntimes API, so this returns the plugin's
 * runtime list via the fetcher pattern. This wiring means:
 *   (a) the option-elicitor treats runtimes the same as AMIs/subnets
 *   (b) when AWS eventually adds a runtime discovery API, only this
 *       function needs to change — the plugin and wizard stay untouched
 *   (c) the 15-minute cache TTL (DISCOVERY_TTL_MS) applies
 */
export async function discoverLambdaRuntimes(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.LAMBDA_RUNTIMES, async () =>
    lambdaRuntimes.map((r) => ({ value: r.value, label: r.label })),
  );
}
