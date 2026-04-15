/**
 * Lambda discovery — returns the canonical Lambda runtime list via the
 * cached fetcher pattern (Story 44.4).
 *
 * AWS does not expose a ListRuntimes API, so this wraps the plugin's
 * runtime list through the fetcher pattern. This means:
 *   (a) the option-elicitor treats runtimes the same as AMIs/subnets
 *   (b) when AWS eventually adds a runtime discovery API, only this
 *       function needs to change — the plugin and wizard stay untouched
 *   (c) the 15-minute cache TTL applies
 */

import { DiscoveryCacheKey, lambdaRuntimes } from "@assignee/core";
import { cachedDiscover } from "./cache.js";
import type { DiscoveryOption } from "./types.js";

export async function discoverLambdaRuntimes(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.LAMBDA_RUNTIMES, async () =>
    lambdaRuntimes.map((r) => ({ value: r.value, label: r.label })),
  );
}
