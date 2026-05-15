/**
 * RDS DB subnet group discovery.
 *
 * EPIC-107-2: existing-resource-discovery extractor — new SDK helper
 * mirroring the efs.ts pattern (~40 LOC).
 */

import { DescribeDBSubnetGroupsCommand } from "@aws-sdk/client-rds";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createRdsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers RDS DB subnet groups in the given region. Paginated via Marker.
 * Shows the subnet group name, description, and status.
 *
 * EPIC-107-2 R2: `region` scopes SDK client + cache key.
 */
export async function discoverDbSubnetGroups(
  region?: string,
): Promise<DiscoveryOption[]> {
  const cacheKey = region
    ? `${DiscoveryCacheKey.DB_SUBNET_GROUPS}:${region}`
    : DiscoveryCacheKey.DB_SUBNET_GROUPS;
  return cachedDiscover(cacheKey, async () => {
    const rds = createRdsClient(region);
    if (!rds) return []; // Graceful no-op: reader creds not configured

    const collected: DiscoveryOption[] = [];
    let marker: string | undefined;
    do {
      const result = await withTimeout(
        rds.send(
          new DescribeDBSubnetGroupsCommand(marker ? { Marker: marker } : {}),
        ),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!result?.DBSubnetGroups) break;
      for (const sg of result.DBSubnetGroups.filter(
        (g) => g.SubnetGroupStatus === "Complete",
      )) {
        const name = sg.DBSubnetGroupName ?? "";
        if (!name) continue;
        const desc = sg.DBSubnetGroupDescription
          ? ` — ${sg.DBSubnetGroupDescription}`
          : "";
        collected.push({ value: name, label: `${name}${desc}` });
      }
      marker = result.Marker;
    } while (marker);
    return collected;
  });
}
