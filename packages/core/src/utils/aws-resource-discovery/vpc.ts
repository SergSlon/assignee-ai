/**
 * VPC discovery: lists VPCs from the account.
 *
 * EPIC-107-2: existing-resource-discovery extractor — new SDK helper
 * mirroring the efs.ts pattern (~40 LOC).
 */

import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createEc2Client } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers VPCs from the account in the given region. Paginated via NextToken.
 * Shows the Name tag, CIDR block, and VPC ID. Default VPC is marked.
 *
 * EPIC-107-2 R2: `region` argument scopes the SDK client AND the cache key
 * (`${VPCS}:${region}`) so session-switches don't return stale data.
 */
export async function discoverVpcs(
  region?: string,
): Promise<DiscoveryOption[]> {
  const cacheKey = region
    ? `${DiscoveryCacheKey.VPCS}:${region}`
    : DiscoveryCacheKey.VPCS;
  return cachedDiscover(cacheKey, async () => {
    const ec2 = createEc2Client(region);
    if (!ec2) return []; // Graceful no-op: reader creds not configured

    const collected: DiscoveryOption[] = [];
    let nextToken: string | undefined;
    do {
      const result = await withTimeout(
        ec2.send(
          new DescribeVpcsCommand(nextToken ? { NextToken: nextToken } : {}),
        ),
        DISCOVERY_TIMEOUT_MS,
      );
      if (!result?.Vpcs) break;
      for (const vpc of result.Vpcs.filter((v) => v.State === "available")) {
        const nameTag = vpc.Tags?.find((t) => t.Key === "Name")?.Value;
        const cidr = vpc.CidrBlock ?? "";
        const isDefault = vpc.IsDefault ? " [default]" : "";
        const label = nameTag
          ? `${nameTag} (${vpc.VpcId}, ${cidr}${isDefault})`
          : `${vpc.VpcId} (${cidr}${isDefault})`;
        if (vpc.VpcId) collected.push({ value: vpc.VpcId, label });
      }
      nextToken = result.NextToken;
    } while (nextToken);
    return collected;
  });
}
