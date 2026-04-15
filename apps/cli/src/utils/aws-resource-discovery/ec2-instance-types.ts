/**
 * EC2 instance-type discovery — groups current-generation instance types
 * by family category (burstable, general, compute, memory, …) so the
 * option-elicitor can present a two-step category → size selector.
 */

import {
  DescribeInstanceTypesCommand,
  type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import { WorkloadProfile as WP } from "../../constants/workload-profiles.js";
import { withTimeout } from "../timeout.js";
import { createEc2Client } from "./clients.js";
import { categorizeFamily } from "./categorize.js";
import {
  DISCOVERY_TIMEOUT_MS,
  type DiscoveryOption,
  type InstanceTypeCategory,
} from "./types.js";

let instanceTypeCache: InstanceTypeCategory[] | null = null;

/**
 * Discovers available EC2 instance types from the account's region.
 * Groups them by family category for the two-step category select.
 * Returns [] on failure — caller falls back to hardcoded categories.
 */
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
