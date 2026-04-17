/**
 * Org policy fetcher with local file cache.
 * Fetches resource option policies from the SaaS API (when auth token is available)
 * and caches to `~/.cache/assignee/org-policy.json` with configurable TTL.
 *
 * All I/O is wrapped in try/catch — this function never throws.
 *
 * Lifted from apps/cli/src/config/org-policy-cache.ts in Story 50-4
 * Wave 5 Pass G so the in-core graph can fetch org policy without
 * reaching back into the CLI app.
 *
 * @see Story 7.2 — AC: 2, 6
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { OrgResourceConfig } from "./resource-policy.js";
import { log, LOG_ACTIONS } from "../utils/logger/index.js";
import { SAAS_API_URL } from "./constants/saas.js";
import {
  ORG_POLICY_TTL_MS,
  ORG_POLICY_FETCH_TIMEOUT_MS,
} from "./constants/timeouts.js";
import { LogSource } from "./constants/enums.js";
import { ContentType } from "../constants/errors.js";
import { loadLocalOrgPolicy, mergeOrgPolicies } from "./org-policy-loader.js";

/** Shape of the cache envelope persisted to disk. */
interface OrgPolicyCacheEnvelope {
  fetchedAt: number;
  data: OrgResourceConfig;
}

/** Resolve the cache file path. */
function resolveCachePath(): string {
  return path.join(os.homedir(), ".cache", "assignee", "org-policy.json");
}

/**
 * Read the auth token from `~/.config/assignee/auth.json`.
 * Returns undefined if the file does not exist or is malformed.
 */
export async function readAuthToken(): Promise<string | undefined> {
  try {
    const authPath = path.join(
      os.homedir(),
      ".config",
      "assignee",
      "auth.json",
    );
    const content = await fs.readFile(authPath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "token" in parsed &&
      typeof (parsed as { token: unknown }).token === "string"
    ) {
      return (parsed as { token: string }).token;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read cached org policy from disk.
 * Returns the data if the cache is within TTL, undefined otherwise.
 */
async function readCache(): Promise<OrgResourceConfig | undefined> {
  try {
    const content = await fs.readFile(resolveCachePath(), "utf-8");
    const envelope: unknown = JSON.parse(content);
    if (
      envelope !== null &&
      typeof envelope === "object" &&
      "fetchedAt" in envelope &&
      "data" in envelope
    ) {
      const typed = envelope as OrgPolicyCacheEnvelope;
      if (Date.now() - typed.fetchedAt < ORG_POLICY_TTL_MS) {
        return typed.data;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write org policy to the cache file.
 */
async function writeCache(data: OrgResourceConfig): Promise<void> {
  const cachePath = resolveCachePath();
  const cacheDir = path.dirname(cachePath);
  await fs.mkdir(cacheDir, { recursive: true });
  const envelope: OrgPolicyCacheEnvelope = {
    fetchedAt: Date.now(),
    data,
  };
  await fs.writeFile(cachePath, JSON.stringify(envelope, null, 2), "utf-8");
}

/**
 * Fetch org policy from SaaS API with cache fallback.
 *
 * - No authToken → returns undefined immediately (no SaaS call in POC)
 * - Fetch succeeds → writes cache, returns data
 * - Fetch fails → falls back to cache if within TTL, else undefined with warn log
 *
 * @param authToken - Bearer token from `~/.config/assignee/auth.json`
 * @returns Org policy config or undefined (never throws)
 */
export async function fetchOrgPolicy(
  authToken: string | undefined,
): Promise<OrgResourceConfig | undefined> {
  if (!authToken) {
    // No SaaS auth — return local org policy if available
    return loadLocalOrgPolicy();
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ORG_POLICY_FETCH_TIMEOUT_MS,
    );

    const response = await fetch(`${SAAS_API_URL}/api/org/resource-policy`, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": ContentType.JSON,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as OrgResourceConfig;

    try {
      await writeCache(data);
    } catch {
      // Cache write failure is non-fatal
    }

    // Merge with local policy if it exists (SaaS wins on collision)
    const localPolicy = await loadLocalOrgPolicy();
    if (localPolicy) {
      const merged = mergeOrgPolicies(localPolicy, data);
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "info",
        action: LOG_ACTIONS.ORG_POLICY_FETCHED,
        extras: { source: "api+local" },
      });
      return merged;
    }

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.ORG_POLICY_FETCHED,
      extras: { source: "api" },
    });

    return data;
  } catch (fetchErr: unknown) {
    // API unreachable — try cache fallback
    const cached = await readCache();
    if (cached) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.ORG_POLICY_FETCHED,
        extras: {
          source: LogSource.CACHE,
          reason: fetchErr instanceof Error ? fetchErr.message : "fetch failed",
        },
      });
      return cached;
    }

    // SaaS and cache both failed — try local org policy as last resort
    const localPolicy = await loadLocalOrgPolicy();
    if (localPolicy) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "info",
        action: LOG_ACTIONS.ORG_POLICY_FETCHED,
        extras: {
          source: "local",
          reason: fetchErr instanceof Error ? fetchErr.message : "fetch failed",
        },
      });
      return localPolicy;
    }

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.ORG_POLICY_FETCHED,
      extras: {
        source: "none",
        reason: fetchErr instanceof Error ? fetchErr.message : "fetch failed",
      },
    });
    return undefined;
  }
}
