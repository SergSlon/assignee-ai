/**
 * KMS resource discovery: customer-managed keys with alias labels.
 */

import { ListKeysCommand, ListAliasesCommand } from "@aws-sdk/client-kms";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createKmsClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers customer-managed KMS keys from the account.
 * - Fetches ListKeys and ListAliases in parallel.
 * - Filters out AWS-managed keys (alias starts with "alias/aws/").
 * - Uses the key alias as the label when available, falling back to the key ID/ARN.
 *
 * Returns keys ordered by alias name (aliases first, bare-key-IDs last).
 */
export async function discoverKmsKeys(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.KMS_KEYS, async () => {
    const kms = createKmsClient();
    if (!kms) return []; // Graceful no-op: reader creds not configured

    const [keysResult, aliasesResult] = await Promise.all([
      withTimeout(kms.send(new ListKeysCommand({})), DISCOVERY_TIMEOUT_MS),
      withTimeout(kms.send(new ListAliasesCommand({})), DISCOVERY_TIMEOUT_MS),
    ]);

    if (!keysResult?.Keys) return [];

    // Build a map from KeyId -> alias name (filter out AWS-managed aliases)
    const aliasMap = new Map<string, string>();
    const awsManagedKeyIds = new Set<string>();
    for (const alias of aliasesResult?.Aliases ?? []) {
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
    for (const key of keysResult.Keys) {
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
  });
}
