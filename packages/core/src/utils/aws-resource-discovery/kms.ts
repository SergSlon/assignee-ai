/**
 * KMS resource discovery: customer-managed keys with alias labels.
 */

import {
  ListKeysCommand,
  ListAliasesCommand,
  type KMSClient,
  type KeyListEntry,
  type AliasListEntry,
} from "@aws-sdk/client-kms";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createKmsClient } from "./clients.js";
import {
  DISCOVERY_TIMEOUT_MS,
  type DiscoveryOption,
  KMS_NEGATIVE_CACHE_TTL_MS,
} from "./types.js";

/** Maximum pages to paginate for ListKeys / ListAliases (1000 keys cap). */
const MAX_KMS_PAGES = 10;

/**
 * Paginate ListKeys until Truncated=false or the page cap is reached.
 * HIGH-2: without pagination, keys on tail pages (>100) are silently missed.
 */
async function listAllKeys(kms: KMSClient): Promise<KeyListEntry[]> {
  const keys: KeyListEntry[] = [];
  let marker: string | undefined;
  for (let page = 0; page < MAX_KMS_PAGES; page++) {
    const result = await withTimeout(
      kms.send(new ListKeysCommand({ Marker: marker })),
      DISCOVERY_TIMEOUT_MS,
    );
    for (const k of result?.Keys ?? []) {
      keys.push(k);
    }
    if (!result?.Truncated) break;
    marker = result.NextMarker;
    if (!marker) break;
  }
  return keys;
}

/**
 * Paginate ListAliases until Truncated=false or the page cap is reached.
 * HIGH-2: without pagination, aliases on tail pages are silently missed,
 * allowing AWS-managed-key aliases to leak through to the output.
 */
async function listAllAliases(kms: KMSClient): Promise<AliasListEntry[]> {
  const aliases: AliasListEntry[] = [];
  let marker: string | undefined;
  for (let page = 0; page < MAX_KMS_PAGES; page++) {
    const result = await withTimeout(
      kms.send(new ListAliasesCommand({ Marker: marker })),
      DISCOVERY_TIMEOUT_MS,
    );
    for (const a of result?.Aliases ?? []) {
      aliases.push(a);
    }
    if (!result?.Truncated) break;
    marker = result.NextMarker;
    if (!marker) break;
  }
  return aliases;
}

/**
 * Discovers customer-managed KMS keys from the account.
 * - Paginates ListKeys and ListAliases independently (HIGH-2).
 * - Fetches them in parallel but degrades gracefully if ListAliases fails
 *   with AccessDenied — keys will display as bare ARNs (HIGH-1).
 * - Filters out AWS-managed keys (alias starts with "alias/aws/").
 * - Uses the key alias as the label when available, falling back to the key ID/ARN.
 *
 * Returns keys ordered by alias name (aliases first, bare-key-IDs last).
 */
export async function discoverKmsKeys(): Promise<DiscoveryOption[]> {
  return cachedDiscover(
    DiscoveryCacheKey.KMS_KEYS,
    async () => {
      const kms = createKmsClient();
      if (!kms) return []; // Graceful no-op: reader creds not configured

      // HIGH-1: use Promise.allSettled so an AccessDenied on ListAliases
      // degrades gracefully — keys still appear with bare-ARN labels.
      const [keysSettled, aliasesSettled] = await Promise.allSettled([
        listAllKeys(kms),
        listAllAliases(kms),
      ]);

      const allKeys =
        keysSettled.status === "fulfilled" ? keysSettled.value : [];
      if (allKeys.length === 0) return [];

      // Build a map from KeyId -> alias name (filter out AWS-managed aliases)
      const aliasMap = new Map<string, string>();
      const awsManagedKeyIds = new Set<string>();
      const allAliases =
        aliasesSettled.status === "fulfilled" ? aliasesSettled.value : [];
      // If aliases fetch failed, aliasMap stays empty — all keys show as bare ARNs.
      for (const alias of allAliases) {
        if (!alias.AliasName || !alias.TargetKeyId) continue;
        // Track AWS-managed keys (alias/aws/...) so they can be excluded from output
        if (alias.AliasName.startsWith("alias/aws/")) {
          awsManagedKeyIds.add(alias.TargetKeyId);
          continue;
        }
        aliasMap.set(alias.TargetKeyId, alias.AliasName);
      }

      // Filter to only customer-managed keys that have a custom alias
      // (bare keys without any alias are very uncommon and not labellable —
      // include them but label them by key ID so power users can still pick them)
      const options: DiscoveryOption[] = [];
      for (const key of allKeys) {
        if (!key.KeyId || !key.KeyArn) continue;
        // Skip keys that have an AWS-managed alias (alias/aws/...)
        if (awsManagedKeyIds.has(key.KeyId)) continue;
        const alias = aliasMap.get(key.KeyId);
        if (alias) {
          // Customer-managed key with a friendly alias
          options.push({
            value: key.KeyArn,
            label: `${alias} — ${key.KeyArn}`,
          });
        } else {
          // Key ID present but no custom alias — check it's not AWS-managed
          // by verifying no alias/aws/... maps to it. Since we already filtered
          // aws/ aliases above, anything remaining is a CMK without an alias.
          options.push({
            value: key.KeyArn,
            label: key.KeyArn,
          });
        }
      }

      // Sort: aliased keys first (alphabetically by alias), bare keys last
      options.sort((a, b) => {
        const aIsAliased = a.label.startsWith("alias/");
        const bIsAliased = b.label.startsWith("alias/");
        if (aIsAliased && !bIsAliased) return -1;
        if (!aIsAliased && bIsAliased) return 1;
        return a.label.localeCompare(b.label);
      });

      return options;
    },
    { negativeCacheTtlMs: KMS_NEGATIVE_CACHE_TTL_MS },
  );
}
