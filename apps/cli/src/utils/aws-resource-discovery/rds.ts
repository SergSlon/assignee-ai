/**
 * RDS discovery: engine versions + instance classes for a given engine.
 */

import {
  DescribeDBEngineVersionsCommand,
  DescribeOrderableDBInstanceOptionsCommand,
} from "@aws-sdk/client-rds";
import { CfnKey, DiscoveryCacheKey, ResourceDefault } from "@assignee/core";
import { WorkloadProfile as WP } from "../../constants/workload-profiles.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createRdsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

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

function classifyRdsFamily(cls: string): string {
  // cls is like "db.t3.micro", "db.m5.large", "db.r6g.large"
  const parts = cls.split(".");
  const familyPrefix = parts[1]?.[0]?.toLowerCase() ?? "";
  if (familyPrefix === "t") return WP.BURSTABLE;
  if (familyPrefix === "m") return WP.GENERAL;
  if (familyPrefix === "r" || familyPrefix === "x") return WP.MEMORY;
  return WP.OTHER;
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
