/**
 * Persistent price cache with configurable TTL.
 * Caches Pricing MCP responses to ~/.assignee/cache/pricing/{serviceCode}-{hash}.json.
 *
 * Default TTL: 60 minutes for compute, 1440 minutes (24h) for storage rates.
 * Configurable via .assignee/config.yaml `priceCacheTtlMinutes`.
 *
 * @see Story 23.4
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { ASSIGNEE_DIR } from "../config/cfn-keys/paths.js";
import { CLEANUP_MAX_AGE_MS } from "../config/constants/timeouts.js";
import { FileName } from "../config/constants/paths.js";
import {
  CleanupCategoryName,
  PricingCategory,
} from "../config/constants/enums.js";

const CACHE_DIR = path.join(
  os.homedir(),
  ASSIGNEE_DIR,
  CleanupCategoryName.CACHE,
  "pricing",
);
const PROJECT_CONFIG_DIR = ASSIGNEE_DIR;
const PROJECT_CONFIG_FILE = FileName.CONFIG;

/** Default TTL in minutes by pricing category. */
const DEFAULT_TTL: Record<string, number> = {
  [PricingCategory.COMPUTE]: 60,
  [PricingCategory.STORAGE]: 1440,
  [PricingCategory.DEFAULT]: 60,
};

interface CacheEntry {
  data: unknown;
  cachedAt: number;
  serviceCode: string;
  filtersHash: string;
}

/**
 * Read the price cache TTL from project config.
 * Returns the configured value or falls back to category-specific defaults.
 */
function readCacheTtlMinutes(category: string, projectDir?: string): number {
  try {
    const configPath = path.resolve(
      projectDir ?? process.cwd(),
      PROJECT_CONFIG_DIR,
      PROJECT_CONFIG_FILE,
    );
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    const ttl = parsed?.["priceCacheTtlMinutes"];
    if (typeof ttl === "number" && ttl > 0) return ttl;
  } catch {
    // Config not available — use defaults
  }
  return DEFAULT_TTL[category] ?? DEFAULT_TTL["default"]!;
}

/**
 * Compute a deterministic hash for a set of pricing filters + service code.
 */
function computeHash(serviceCode: string, filters: unknown[]): string {
  const key = JSON.stringify({ serviceCode, filters });
  // SHA-256 — collision-resistance is not strictly required for a cache key,
  // but compliance scanners (and our own audits) flag MD5 unconditionally.
  // We slice to 12 hex chars to keep filenames short while preserving
  // ~48 bits of entropy, which is more than sufficient for cache de-duplication.
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/**
 * Ensure the cache directory exists with restrictive permissions (0o700).
 * Owner-only access prevents other local users from reading cached pricing data.
 */
function ensureCacheDir(): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Get a cached pricing response if it exists and is within TTL.
 *
 * @param serviceCode - AWS service code
 * @param filters - Pricing filters used in the query
 * @param category - "compute" | "storage" | "default" for TTL selection
 * @param projectDir - Optional project directory for config resolution (MCP servers may have different cwd)
 * @returns Cached data or null if expired/missing
 */
export function getCachedPrice(
  serviceCode: string,
  filters: unknown[],
  category = "default",
  projectDir?: string,
): unknown | null {
  const hash = computeHash(serviceCode, filters);
  const safe = serviceCode.replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path.join(CACHE_DIR, `${safe}-${hash}.json`);

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const entry = JSON.parse(content) as CacheEntry;

    if (typeof entry.cachedAt !== "number" || isNaN(entry.cachedAt))
      return null;

    const ttlMinutes = readCacheTtlMinutes(category, projectDir);
    const ttlMs = ttlMinutes * 60 * 1000;
    const age = Date.now() - entry.cachedAt;

    if (age > ttlMs) {
      // Expired — delete stale entry
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore deletion errors
      }
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Store a pricing response in the persistent cache.
 *
 * @param serviceCode - AWS service code
 * @param filters - Pricing filters used in the query
 * @param data - The pricing response data to cache
 */
export function setCachedPrice(
  serviceCode: string,
  filters: unknown[],
  data: unknown,
): void {
  try {
    ensureCacheDir();
    const hash = computeHash(serviceCode, filters);
    const safe = serviceCode.replace(/[^a-zA-Z0-9_-]/g, "");
    const filePath = path.join(CACHE_DIR, `${safe}-${hash}.json`);

    const entry: CacheEntry = {
      data,
      cachedAt: Date.now(),
      serviceCode,
      filtersHash: hash,
    };

    fs.writeFileSync(filePath, JSON.stringify(entry), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Cache write failures are non-blocking
  }
}

/**
 * Sweep expired price cache entries.
 * Deletes .json files older than maxAgeMs or with corrupt/missing cachedAt.
 *
 * @param maxAgeMs - Maximum age in milliseconds (default 24h)
 * @param cacheDir - Directory to sweep (defaults to standard cache dir)
 * @returns Count of removed and remaining files
 * @see Story 33.1
 */
export function sweepExpiredPrices(
  maxAgeMs: number = CLEANUP_MAX_AGE_MS,
  cacheDir: string = CACHE_DIR,
): { removed: number; remaining: number } {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return { removed: 0, remaining: 0 };
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  let removed = 0;
  let remaining = 0;
  const now = Date.now();

  for (const file of jsonFiles) {
    const filePath = path.join(cacheDir, file);
    let shouldRemove = false;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry = JSON.parse(content) as { cachedAt?: unknown };
      if (typeof entry.cachedAt !== "number" || isNaN(entry.cachedAt)) {
        shouldRemove = true;
      } else if (now - entry.cachedAt > maxAgeMs) {
        shouldRemove = true;
      }
    } catch {
      shouldRemove = true;
    }

    if (shouldRemove) {
      try {
        fs.unlinkSync(filePath);
        removed++;
      } catch {
        remaining++;
      }
    } else {
      remaining++;
    }
  }

  return { removed, remaining };
}

/**
 * Clear all cached pricing data.
 */
export function clearPriceCache(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  } catch {
    // Directory may not exist yet
  }
}
