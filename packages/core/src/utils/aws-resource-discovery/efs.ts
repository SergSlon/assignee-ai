/**
 * EFS resource discovery: file systems.
 */

import { DescribeFileSystemsCommand } from "@aws-sdk/client-efs";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createEfsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers EFS file systems from the account.
 * Shows the Name tag (from FileSystemTags), lifecycle state, and file system ID.
 */
export async function discoverEfsFileSystems(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.EFS_FILE_SYSTEMS, async () => {
    const efs = createEfsClient();
    if (!efs) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      efs.send(new DescribeFileSystemsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.FileSystems) return [];

    return result.FileSystems.filter((fs) => fs.LifeCycleState === "available")
      .map((fs) => {
        const nameTag = fs.Tags?.find((t) => t.Key === "Name")?.Value;
        const sizeGib = fs.SizeInBytes?.Value
          ? ` ${Math.round(Number(fs.SizeInBytes.Value) / 1073741824)}GiB`
          : "";
        const label = nameTag
          ? `${nameTag} (${fs.FileSystemId}${sizeGib})`
          : `${fs.FileSystemId}${sizeGib}`;
        return { value: fs.FileSystemId!, label };
      })
      .filter((o) => o.value);
  });
}
