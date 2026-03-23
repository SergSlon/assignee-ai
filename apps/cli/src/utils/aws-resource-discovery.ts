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
  type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { withTimeout } from "./timeout.js";

const DISCOVERY_TIMEOUT_MS = 6000;

/** Option shape compatible with ResourceField question options. */
export interface DiscoveryOption {
  value: string;
  label: string;
}

// ── Session cache ────────────────────────────────────────────────────────────
const discoveryCache = new Map<string, DiscoveryOption[]>();

/** Reset cache — used by tests and when region changes. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

async function cachedDiscover(
  key: string,
  fetcher: () => Promise<DiscoveryOption[]>,
): Promise<DiscoveryOption[]> {
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  try {
    const results = await fetcher();
    if (results.length > 0) {
      discoveryCache.set(key, results);
    }
    return results;
  } catch {
    // Discovery is best-effort — callers fall back to manual entry.
    return [];
  }
}

// ── Shared client factory ────────────────────────────────────────────────────

function readerCredentials(): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
} {
  return {
    accessKeyId: process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] ?? "",
    region: process.env["AWS_REGION"] ?? "us-east-1",
  };
}

function createEc2Client(): EC2Client {
  const creds = readerCredentials();
  return new EC2Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

function createSsmClient(): SSMClient {
  const creds = readerCredentials();
  return new SSMClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
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
      key: "burstable",
      label: "Burstable",
      description: "Dev, small production, variable workloads",
    };
  if (prefix.startsWith("m"))
    return {
      key: "general",
      label: "General Purpose",
      description: "Balanced compute, memory, networking",
    };
  if (prefix.startsWith("c"))
    return {
      key: "compute",
      label: "Compute Optimized",
      description: "Batch, HPC, gaming, ML inference",
    };
  if (prefix.startsWith("r") || prefix.startsWith("x"))
    return {
      key: "memory",
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
      key: "accelerated",
      label: "GPU / Accelerated",
      description: "ML training, inference, graphics, video",
    };
  if (
    prefix.startsWith("i") ||
    prefix.startsWith("d") ||
    prefix.startsWith("h")
  )
    return {
      key: "storage",
      label: "Storage Optimized",
      description: "High I/O, data warehousing, distributed filesystems",
    };
  if (prefix.startsWith("hpc"))
    return {
      key: "hpc",
      label: "HPC",
      description: "High-performance computing",
    };
  if (prefix.startsWith("a"))
    return {
      key: "arm",
      label: "ARM (Graviton 1st gen)",
      description: "ARM workloads, lowest cost",
    };
  return { key: "other", label: "Other", description: prefix };
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
        "burstable",
        "general",
        "compute",
        "memory",
        "accelerated",
        "storage",
        "hpc",
        "arm",
        "other",
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
  return cachedDiscover("amis", async () => {
    const ssm = createSsmClient();
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
      if (r.status === "fulfilled" && r.value) {
        options.push(r.value);
      }
    }
    return options;
  });
}

/**
 * Discovers VPC subnets from the account.
 * Shows Name tag, CIDR block, and availability zone.
 */
export async function discoverSubnets(): Promise<DiscoveryOption[]> {
  return cachedDiscover("subnets", async () => {
    const ec2 = createEc2Client();
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
  return cachedDiscover("security-groups", async () => {
    const ec2 = createEc2Client();
    const result = await withTimeout(
      ec2.send(new DescribeSecurityGroupsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.SecurityGroups) return [];

    return result.SecurityGroups.filter((sg) => sg.GroupName !== "default")
      .map((sg) => {
        const desc =
          sg.Description && sg.Description !== sg.GroupName
            ? ` — ${sg.Description}`
            : "";
        return {
          value: sg.GroupId!,
          label: `${sg.GroupName}${desc} (${sg.GroupId})`,
        };
      })
      .filter((o) => o.value);
  });
}

/**
 * Discovers EC2 key pairs from the account.
 * Prepends a "None (SSM access only)" option.
 */
export async function discoverKeyPairs(): Promise<DiscoveryOption[]> {
  return cachedDiscover("key-pairs", async () => {
    const ec2 = createEc2Client();
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
