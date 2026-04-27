/**
 * EC2 instance-type discovery — groups current-generation instance types
 * by family category (burstable, general, compute, memory, …) so the
 * option-elicitor can present a two-step category → size selector.
 *
 * MASTER-008 (RW4a): the previous module-level
 * `let instanceTypeCache: InstanceTypeCategory[] | null` returned
 * tenant A's discovered instance types to tenant B for the lifetime
 * of the process. Two AWS accounts in two different regions have
 * different instance-type availability (graviton families are not in
 * every region; some accounts have opt-in regions enabled), so the
 * cross-tenant leak silently surfaced unavailable instance types in
 * the option elicitor for the second tenant. Replaced with a
 * {@link TenantScopedCache} keyed on (accountId, region, roleArn?).
 */

import {
  DescribeInstanceTypesCommand,
  type InstanceTypeInfo,
} from "@aws-sdk/client-ec2";
import { WorkloadProfileKey as WP } from "../../config/cfn-keys.js";
import { withTimeout } from "../timeout.js";
import { createEc2Client } from "./clients.js";
import { categorizeFamily } from "./categorize.js";
import {
  DISCOVERY_TIMEOUT_MS,
  type DiscoveryOption,
  type InstanceTypeCategory,
} from "./types.js";
import {
  type TenantId,
  createLegacySingleTenantId,
} from "../../tenant/tenant-id.js";
import { TenantScopedCache } from "../../tenant/tenant-scoped-cache.js";

const instanceTypeCache = new TenantScopedCache<InstanceTypeCategory[]>();

/**
 * Discovers available EC2 instance types from the account's region.
 * Groups them by family category for the two-step category select.
 * Returns [] on failure — caller falls back to hardcoded categories.
 *
 * `tenantId` is optional during the migration: when omitted, falls
 * back to {@link createLegacySingleTenantId} which derives identity
 * from `AWS_ACCOUNT_ID` / `AWS_REGION` env vars.
 *
 * TODO(SaaS): make `tenantId` required once
 * `option-elicitor/parallel-enrichment.ts` (the one production caller)
 * threads it through from graph state.
 */
export async function discoverInstanceTypes(
  tenantId?: TenantId,
): Promise<InstanceTypeCategory[]> {
  const tid = tenantId ?? createLegacySingleTenantId();
  const cached = instanceTypeCache.get(tid);
  if (cached) return cached;

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
      instanceTypeCache.set(tid, categories);
    }
    return categories;
  } catch {
    return [];
  }
}

/**
 * @internal Resets the cached instance-type catalogue. Testing only.
 *
 * Tenant-scoped: pass `tenantId` to evict only that tenant's cache.
 * No argument → wipe every tenant.
 */
export function _resetInstanceTypeCacheForTests(tenantId?: TenantId): void {
  if (tenantId) instanceTypeCache.clear(tenantId);
  else instanceTypeCache.clear();
}
