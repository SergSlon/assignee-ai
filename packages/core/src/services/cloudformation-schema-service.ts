/**
 * CloudFormation Schema Fetcher Service.
 * Fetches resource type schemas via the AWS SDK DescribeType API with disk caching.
 *
 * Fetches CloudFormation resource schemas via direct AWS SDK DescribeType calls.
 *
 * @see Story 31.1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  CloudFormationClient,
  DescribeTypeCommand,
} from "@aws-sdk/client-cloudformation";
import { AssigneeError } from "../errors.js";
import { DEFAULT_AWS_REGION } from "../config/config-schema.js";
import { ASSIGNEE_DIR, CACHE_DIR_NAME } from "../config/cfn-keys.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import { log, LOG_ACTIONS, LogLevel } from "../utils/logger/index.js";

/** Default cache directory under ~/.assignee */
const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  ASSIGNEE_DIR,
  CACHE_DIR_NAME,
  "schemas",
);

/** Default TTL: 7 days in milliseconds */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default AWS region */
const DEFAULT_REGION = DEFAULT_AWS_REGION;

/** Configuration options for CloudFormationSchemaService */
export interface CloudFormationSchemaServiceConfig {
  cacheDir?: string;
  cacheTtlMs?: number;
  region?: string;
}

/**
 * Typed error thrown when a CloudFormation schema fetch fails.
 * Carries the resource type name and the root cause.
 */
export class SchemaFetchError extends AssigneeError {
  public readonly typeName: string;
  public readonly rootCause: Error;

  constructor(typeName: string, rootCause: Error) {
    super(
      `Failed to fetch CloudFormation schema for "${typeName}": ${rootCause.message}`,
      "SCHEMA_FETCH_ERROR",
    );
    this.name = "SchemaFetchError";
    this.typeName = typeName;
    this.rootCause = rootCause;
  }
}

/**
 * Fetches and caches CloudFormation resource type schemas using the DescribeType API.
 *
 * Caches schemas to disk with a configurable TTL. Uses ASSIGNEE_READER_*
 * credentials for AWS access via the centralized
 * `requireAssigneeCredentials("reader")` helper — NEVER falls through to
 * ~/.aws/credentials / SSO / IMDS.
 *
 * Credentials are resolved PER REQUEST (not at constructor time) so .env
 * changes during a process lifetime are honored.
 */
export class CloudFormationSchemaService {
  private readonly client: CloudFormationClient;
  private readonly cacheDir: string;
  private readonly cacheTtlMs: number;

  /**
   * In-flight dedup map: tracks active fetchFromApi Promises by type name.
   *
   * When N concurrent callers request the same resource type on a cache miss,
   * the first caller inserts a Promise here; subsequent callers receive that
   * same Promise instead of spawning their own DescribeType API call. The
   * entry is deleted (in a `finally` block) when the fetch settles — on both
   * resolve AND reject — so the cache-TTL flow takes over from that point.
   *
   * Instance-scoped (not static/module-level) so each service instance owns
   * its own dedup state. This is correct because W12-prelude made the service
   * per-graph (no shared singleton).
   */
  private readonly _inFlight = new Map<string, Promise<object>>();

  constructor(config?: CloudFormationSchemaServiceConfig) {
    this.cacheDir = config?.cacheDir ?? DEFAULT_CACHE_DIR;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_TTL_MS;

    const region = config?.region ?? DEFAULT_REGION;

    // Resolve reader credentials lazily, per request — not at construction.
    // The credentialDefaultProvider closure is invoked by the SDK on each
    // request, so process.env changes are honored and all drift from the
    // shared `requireAssigneeCredentials("reader")` helper is eliminated.
    //
    // The helper throws MissingAssigneeCredentialsError (with the exact env
    // var names) if ASSIGNEE_READER_* are unset — it NEVER falls through to
    // the default credential chain.
    this.client = new CloudFormationClient({
      region,
      credentialDefaultProvider: () => async () => {
        return requireAssigneeCredentials("reader");
      },
    });
  }

  /**
   * Convert a CloudFormation type name to a filesystem-safe cache filename.
   * Replaces `::` with `__` per the story spec.
   *
   * Defence-in-depth: although every current caller passes a value from a
   * constrained allowlist (SUPPORTED_TYPES_ARRAY), validate the shape here so
   * a future caller bug cannot turn an arbitrary string into a path-traversal
   * primitive (e.g. `../../etc/passwd`). CloudFormation type names are
   * restricted to `AWS::Service::Resource` style identifiers, so a strict
   * `[A-Za-z0-9:]+` allowlist is sufficient.
   */
  private cacheFileName(typeName: string): string {
    if (!/^[A-Za-z0-9:]+$/.test(typeName)) {
      throw new AssigneeError(
        `Invalid CloudFormation type name for cache key: "${typeName}". ` +
          `Type names must match /^[A-Za-z0-9:]+$/.`,
        "INVALID_TYPE_NAME",
      );
    }
    return `${typeName.replaceAll("::", "__")}.json`;
  }

  /** Full path to the cache file for a given type name. */
  private cacheFilePath(typeName: string): string {
    return path.join(this.cacheDir, this.cacheFileName(typeName));
  }

  /**
   * Fetch the CloudFormation schema for a resource type.
   *
   * Returns from disk cache if available and within TTL, otherwise
   * calls the DescribeType API and caches the result.
   *
   * Stale-cache fallback (7-day TTL expiry + API error):
   * If the cache exists but is expired AND the DescribeType API throws for
   * any reason (XML parse error, network failure, throttling, etc.), the
   * service returns the stale cached value rather than propagating the error.
   * A structured WARN event is emitted to the rotating daily log and to
   * stderr (under --verbose) with the type name, error message, cache file
   * path, and a recovery hint. The cache mtime is NOT refreshed so
   * subsequent calls retry the API until it succeeds.
   *
   * No-cache + API error:
   * If there is no cached value at all, the error is propagated as a
   * SchemaFetchError — no fallback is possible.
   */
  async getSchema(typeName: string): Promise<object> {
    // Check cache first — returns { schema, stale } or null (no file).
    const cached = await this.readCache(typeName);
    if (cached !== null && !cached.stale) {
      return cached.schema;
    }

    // Cache miss or expired — check whether a fetch is already in flight for
    // this type name. If so, reuse the existing Promise (dedup: N callers → 1
    // DescribeType API call). The first caller creates the Promise, stores it
    // in _inFlight, and all subsequent concurrent callers await that same
    // Promise. On settle (resolve OR reject) the entry is removed so the
    // cache-TTL flow takes over for the next caller.
    const existingFetch = this._inFlight.get(typeName);
    if (existingFetch !== undefined) {
      return existingFetch;
    }

    const fetchPromise = (async () => {
      try {
        let schema: object;
        try {
          schema = await this.fetchFromApi(typeName);
        } catch (fetchError: unknown) {
          // API threw — check whether we can fall back to a stale cache entry.
          if (cached !== null && cached.stale) {
            const cacheFilePath = this.cacheFilePath(typeName);
            const errMsg =
              fetchError instanceof Error
                ? fetchError.message
                : String(fetchError);
            log({
              ts: new Date().toISOString(),
              runId: "system",
              level: LogLevel.WARN,
              action: LOG_ACTIONS.SCHEMA_STALE_CACHE_FALLBACK,
              extras: {
                typeName,
                error: errMsg,
                cacheFile: cacheFilePath,
                hint: `Run: touch "${cacheFilePath}" to force a retry on next invocation, or delete the file to force a full refresh.`,
              },
            });
            // Return stale value — mtime is intentionally NOT updated so we
            // keep retrying the API on subsequent calls.
            return cached.schema;
          }
          // No cache at all — propagate the error (re-throw the SchemaFetchError
          // that fetchFromApi already wrapped it in).
          throw fetchError;
        }

        // Write to cache (best effort — don't fail if cache write fails)
        try {
          await this.writeCache(typeName, schema);
        } catch {
          // Cache write failures are non-blocking
        }

        return schema;
      } finally {
        // Remove the in-flight entry whether the fetch resolved or rejected.
        // This ensures a subsequent caller after a failure retries the API
        // rather than receiving a cached rejection.
        this._inFlight.delete(typeName);
      }
    })();

    this._inFlight.set(typeName, fetchPromise);
    return fetchPromise;
  }

  /**
   * Invalidate cached schemas.
   * If typeName is provided, only that type's cache is cleared.
   * If no typeName, all cached schemas are cleared.
   */
  async invalidateCache(typeName?: string): Promise<void> {
    if (typeName) {
      const filePath = this.cacheFilePath(typeName);
      try {
        await fs.unlink(filePath);
      } catch {
        // File may not exist — that's fine
      }
      return;
    }

    // Clear all cached schemas
    try {
      const files = await fs.readdir(this.cacheDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          await fs.unlink(path.join(this.cacheDir, file));
        }
      }
    } catch {
      // Directory may not exist — that's fine
    }
  }

  /**
   * Read a cached schema if it exists.
   *
   * Returns:
   *   - `null` when the file does not exist, is unreadable, or contains
   *     corrupt JSON (the corrupt file is unlinked so the next call sees a
   *     clean cache miss).
   *   - `{ schema, stale: false }` when the file is fresh (within TTL).
   *   - `{ schema, stale: true }` when the file exists and parses cleanly
   *     but has exceeded the TTL. The caller decides whether to use the
   *     stale value as a fallback.
   */
  private async readCache(
    typeName: string,
  ): Promise<{ schema: object; stale: boolean } | null> {
    const filePath = this.cacheFilePath(typeName);
    let content: string;
    let stale: boolean;
    try {
      const stat = await fs.stat(filePath);
      const age = Date.now() - stat.mtimeMs;
      stale = age > this.cacheTtlMs;
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      return null; // File doesn't exist or is unreadable
    }

    try {
      const entry = JSON.parse(content) as {
        schema: object;
        cachedAt: number;
        typeName: string;
      };
      return { schema: entry.schema, stale };
    } catch {
      // Corrupt JSON (e.g. truncated mid-write). Without unlinking, every
      // subsequent getSchema() call would re-read the same broken file,
      // see a fresh-enough mtime, fail to parse, and re-fetch from the API
      // forever. Delete the corrupt entry so the next call falls through
      // to a clean cache miss + write.
      try {
        await fs.unlink(filePath);
      } catch {
        // Best effort — concurrent unlink or permission error is non-fatal.
      }
      return null;
    }
  }

  /**
   * Write a schema to the cache directory.
   */
  private async writeCache(typeName: string, schema: object): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const filePath = this.cacheFilePath(typeName);
    const entry = {
      schema,
      cachedAt: Date.now(),
      typeName,
    };
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  /**
   * Fetch a schema from the CloudFormation DescribeType API.
   * Includes one retry on throttling errors with a 1s delay.
   */
  private async fetchFromApi(
    typeName: string,
    retried = false,
  ): Promise<object> {
    try {
      const result = await this.client.send(
        new DescribeTypeCommand({
          Type: "RESOURCE",
          TypeName: typeName,
        }),
      );

      if (!result.Schema) {
        throw new Error("DescribeType returned no Schema field");
      }

      return JSON.parse(result.Schema) as object;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Retry once on throttling
      if (!retried && isThrottlingError(err)) {
        await delay(THROTTLE_RETRY_DELAY_MS);
        return this.fetchFromApi(typeName, true);
      }

      throw new SchemaFetchError(typeName, err);
    }
  }
}

/** AWS error names checked for throttling detection. */
const THROTTLE_KEYWORD = "Throttling" as const;
const RATE_EXCEEDED_KEYWORD = "Rate exceeded" as const;
const THROTTLE_ERROR_NAMES = [
  THROTTLE_KEYWORD,
  "ThrottlingException",
  "RequestLimitExceeded",
] as const;

/** Check if an error is a throttling/rate-limit error. */
function isThrottlingError(error: Error): boolean {
  const name = (error as { name?: string }).name ?? "";
  const message = error.message ?? "";
  return (
    (THROTTLE_ERROR_NAMES as readonly string[]).includes(name) ||
    message.includes(RATE_EXCEEDED_KEYWORD) ||
    message.includes(THROTTLE_KEYWORD)
  );
}

/** Delay before retrying a throttled DescribeType request (ms). */
const THROTTLE_RETRY_DELAY_MS = 1000;

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
