/**
 * Schema Cache Warmer — pre-fetches CloudFormation schemas in parallel.
 *
 * Warms the schema cache by fetching all supported resource type schemas
 * with bounded concurrency to avoid API throttling.
 *
 * @see Story 31.6
 */

import { CloudFormationSchemaService } from "./cloudformation-schema-service.js";
import { SUPPORTED_TYPES_ARRAY } from "../config/resource-types.js";

/** Result of a cache warming run. */
export interface WarmResult {
  /** Resource types whose schemas were successfully fetched or served from cache. */
  succeeded: string[];
  /** Resource types whose schema fetch failed, with error details. */
  failed: Array<{ type: string; error: string }>;
}

/** Options for the warmAll method. */
export interface WarmOptions {
  /** Maximum number of concurrent schema fetches. Defaults to 5. */
  concurrency?: number;
  /** Called after each type completes (success or failure). */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Pre-fetches CloudFormation resource type schemas into the disk cache.
 *
 * Uses the CloudFormationSchemaService's built-in cache-check (TTL-based)
 * so already-cached types are skipped automatically.
 */
export class SchemaCacheWarmer {
  private readonly schemaService: CloudFormationSchemaService;

  constructor(schemaService: CloudFormationSchemaService) {
    this.schemaService = schemaService;
  }

  /**
   * Warm the cache for the given types (defaults to SUPPORTED_TYPES_ARRAY).
   *
   * Fetches schemas in parallel, limited to `concurrency` concurrent requests.
   * Individual failures are recorded but do not abort the overall warming.
   */
  async warmAll(
    types: readonly string[] = SUPPORTED_TYPES_ARRAY,
    options?: WarmOptions,
  ): Promise<WarmResult> {
    const concurrency = options?.concurrency ?? 5;
    const onProgress = options?.onProgress;
    const total = types.length;

    const succeeded: string[] = [];
    const failed: Array<{ type: string; error: string }> = [];
    let completed = 0;

    const executing = new Set<Promise<void>>();

    for (const typeName of types) {
      const p = (async () => {
        try {
          await this.schemaService.getSchema(typeName);
          succeeded.push(typeName);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ type: typeName, error: message });
        } finally {
          completed++;
          onProgress?.(completed, total);
        }
      })().finally(() => executing.delete(p));

      executing.add(p);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);

    return { succeeded, failed };
  }
}
