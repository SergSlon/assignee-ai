/**
 * ECS cluster discovery.
 *
 * EPIC-107-2: existing-resource-discovery extractor — new SDK helper
 * mirroring the efs.ts pattern (~40 LOC).
 */

import {
  ListClustersCommand,
  DescribeClustersCommand,
} from "@aws-sdk/client-ecs";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createEcsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers ECS clusters in the given region. List+Describe pagination
 * via nextToken (ListClusters returns up to 100 ARNs per page;
 * DescribeClusters accepts up to 100 ARNs per call — so each page of
 * ARNs is sent as one Describe call).
 *
 * EPIC-107-2 R2: `region` scopes SDK client + cache key.
 */
export async function discoverEcsClusters(
  region?: string,
): Promise<DiscoveryOption[]> {
  const cacheKey = region
    ? `${DiscoveryCacheKey.ECS_CLUSTERS}:${region}`
    : DiscoveryCacheKey.ECS_CLUSTERS;
  return cachedDiscover(cacheKey, async () => {
    const ecs = createEcsClient(region);
    if (!ecs) return []; // Graceful no-op: reader creds not configured

    const collected: DiscoveryOption[] = [];
    let nextToken: string | undefined;
    do {
      const listResult = await withTimeout(
        ecs.send(new ListClustersCommand(nextToken ? { nextToken } : {})),
        DISCOVERY_TIMEOUT_MS,
      );
      const arns = listResult?.clusterArns;
      if (arns && arns.length > 0) {
        const descResult = await withTimeout(
          ecs.send(new DescribeClustersCommand({ clusters: arns })),
          DISCOVERY_TIMEOUT_MS,
        );
        if (descResult?.clusters) {
          for (const c of descResult.clusters.filter(
            (cl) => cl.status === "ACTIVE",
          )) {
            const name = c.clusterName ?? c.clusterArn ?? "";
            if (!name) continue;
            const services = c.activeServicesCount ?? 0;
            const label = `${name} (${services} service${services === 1 ? "" : "s"})`;
            collected.push({ value: name, label });
          }
        }
      }
      nextToken = listResult?.nextToken;
    } while (nextToken);
    return collected;
  });
}
