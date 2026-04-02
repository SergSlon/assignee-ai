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

/** Default cache directory under ~/.assignee */
const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  ".assignee",
  "cache",
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
 * credentials for AWS access.
 */
export class CloudFormationSchemaService {
  private readonly client: CloudFormationClient;
  private readonly cacheDir: string;
  private readonly cacheTtlMs: number;

  constructor(config?: CloudFormationSchemaServiceConfig) {
    this.cacheDir = config?.cacheDir ?? DEFAULT_CACHE_DIR;
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_TTL_MS;

    const region = config?.region ?? DEFAULT_REGION;

    const accessKeyId = process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
    const secretAccessKey = process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
    const credentials =
      accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined;

    this.client = new CloudFormationClient({
      region,
      ...(credentials ? { credentials } : {}),
    });
  }

  /**
   * Convert a CloudFormation type name to a filesystem-safe cache filename.
   * Replaces `::` with `__` per the story spec.
   */
  private cacheFileName(typeName: string): string {
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
   */
  async getSchema(typeName: string): Promise<object> {
    // Check cache first
    const cached = await this.readCache(typeName);
    if (cached !== null) {
      return cached;
    }

    // Cache miss or expired — fetch from API
    const schema = await this.fetchFromApi(typeName);

    // Write to cache (best effort — don't fail if cache write fails)
    try {
      await this.writeCache(typeName, schema);
    } catch {
      // Cache write failures are non-blocking
    }

    return schema;
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
   * Read a cached schema if it exists and is within TTL.
   * Returns null on cache miss or expiry.
   */
  private async readCache(typeName: string): Promise<object | null> {
    const filePath = this.cacheFilePath(typeName);
    try {
      const stat = await fs.stat(filePath);
      const age = Date.now() - stat.mtimeMs;
      if (age > this.cacheTtlMs) {
        return null; // Expired
      }
      const content = await fs.readFile(filePath, "utf-8");
      const entry = JSON.parse(content) as {
        schema: object;
        cachedAt: number;
        typeName: string;
      };
      return entry.schema;
    } catch {
      return null; // File doesn't exist or is unreadable
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
