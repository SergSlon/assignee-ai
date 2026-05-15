/**
 * ELB v2 (Application/Network Load Balancer) discovery.
 *
 * EPIC-107-2: existing-resource-discovery extractor — new SDK helper
 * mirroring the efs.ts pattern (~40 LOC).
 */

import { DescribeLoadBalancersCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createElbClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers Application and Network Load Balancers in the given region.
 * Paginated via Marker. Shows the load balancer name, type, and ARN.
 *
 * EPIC-107-2 R2: `region` scopes SDK client + cache key.
 */
export async function discoverElbs(
  region?: string,
): Promise<DiscoveryOption[]> {
  const cacheKey = region
    ? `${DiscoveryCacheKey.ELBS}:${region}`
    : DiscoveryCacheKey.ELBS;
  return cachedDiscover(cacheKey, async () => {
    const elb = createElbClient(region);
    if (!elb) return []; // Graceful no-op: reader creds not configured

    const collected: DiscoveryOption[] = [];
    let marker: string | undefined;
    do {
      const result = await withTimeout(
        elb.send(
          new DescribeLoadBalancersCommand(marker ? { Marker: marker } : {}),
        ),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!result?.LoadBalancers) break;
      for (const lb of result.LoadBalancers.filter(
        (l) => l.State?.Code === "active",
      )) {
        const name = lb.LoadBalancerName ?? "";
        const type = lb.Type ? ` [${lb.Type}]` : "";
        const label = `${name}${type} (${lb.LoadBalancerArn ?? ""})`;
        const value = lb.LoadBalancerArn ?? name;
        if (value) collected.push({ value, label });
      }
      marker = result.NextMarker;
    } while (marker);
    return collected;
  });
}
