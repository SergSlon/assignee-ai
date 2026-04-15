/**
 * Dynamic field resolution — runs registered fetchers concurrently to
 * populate live AWS options into enum fields.
 */

import * as clack from "@clack/prompts";
import { isAccessDeniedError } from "@assignee/core";
import type { ResourceField } from "@assignee/core";
import { DiscoveryCacheKey } from "../aws-resource-discovery.js";
import {
  discoverAmis,
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  discoverLambdaRuntimes,
} from "../aws-resource-discovery.js";
import { fieldFetchKey } from "./show-if.js";

/** Maps fetcher identifiers to discovery functions. */
const fetcherMap: Record<
  string,
  (
    context?: Record<string, unknown>,
  ) => Promise<Array<{ value: string; label: string }>>
> = {
  [DiscoveryCacheKey.AMIS]: discoverAmis,
  [DiscoveryCacheKey.SUBNETS]: discoverSubnets,
  [DiscoveryCacheKey.SECURITY_GROUPS]: discoverSecurityGroups,
  [DiscoveryCacheKey.KEY_PAIRS]: discoverKeyPairs,
  [DiscoveryCacheKey.RDS_ENGINE_VERSIONS]: discoverRdsEngineVersions,
  [DiscoveryCacheKey.RDS_INSTANCE_CLASSES]: discoverRdsInstanceClasses,
  [DiscoveryCacheKey.LAMBDA_RUNTIMES]: discoverLambdaRuntimes,
};

/** Human-readable spinner messages per fetcher ID. */
const fetcherSpinnerMessages: Record<string, string> = {
  [DiscoveryCacheKey.AMIS]: "Discovering available AMIs...",
  [DiscoveryCacheKey.SUBNETS]: "Discovering available subnets...",
  [DiscoveryCacheKey.SECURITY_GROUPS]: "Discovering security groups...",
  [DiscoveryCacheKey.KEY_PAIRS]: "Discovering key pairs...",
  [DiscoveryCacheKey.RDS_ENGINE_VERSIONS]:
    "Fetching available database engine versions from AWS...",
  [DiscoveryCacheKey.RDS_INSTANCE_CLASSES]:
    "Fetching available database instance classes from AWS...",
  [DiscoveryCacheKey.LAMBDA_RUNTIMES]: "Loading Lambda runtime options...",
};

/**
 * Returns a spinner message appropriate for the set of fetcher IDs that will run.
 * Single fetcher -> resource-specific message; multiple -> generic message.
 * Returns null if no dynamic fields need fetching.
 */
export function getDiscoverySpinnerMessage(
  fields: ResourceField[],
): string | null {
  const fetcherIds = new Set(
    fields
      .filter((f) => f.question.fetcher && fetcherMap[f.question.fetcher])
      .map((f) => f.question.fetcher!),
  );
  if (fetcherIds.size === 0) return null;
  if (fetcherIds.size === 1) {
    const id = [...fetcherIds][0]!;
    return (
      fetcherSpinnerMessages[id] ?? "Discovering available options from AWS..."
    );
  }
  return "Discovering available options from AWS...";
}

/**
 * Resolves dynamic fields by fetching live options from AWS.
 * Fields with a `fetcher` identifier get their options populated at runtime.
 * If a fetch returns empty results, the field reverts to string type for manual entry.
 * Spinner-free — callers are responsible for spinner lifecycle.
 * @see Story 7.11
 */
export async function resolveDynamicFields(
  fields: ResourceField[],
  context?: Record<string, unknown>,
): Promise<ResourceField[]> {
  const dynamicFields = fields.filter((f) => f.question.fetcher);
  if (dynamicFields.length === 0) return fields;

  const fetchResults = new Map<
    string,
    Array<{ value: string; label: string }>
  >();
  const warnedKeys = new Set<string>();
  await Promise.all(
    dynamicFields.map(async (field) => {
      const fetch = fetcherMap[field.question.fetcher!];
      if (!fetch) return;
      const key = fieldFetchKey(field);
      try {
        // Build per-field context: merge global context with showIf condition data
        // so fetchers like discover-rds-engine-versions know which engine to query.
        const fieldContext = field.question.showIf
          ? {
              ...context,
              [field.question.showIf.field]: field.question.showIf.value,
            }
          : context;
        const options = await fetch(fieldContext);
        fetchResults.set(key, options);
      } catch (err: unknown) {
        // Wave 4 F2: structured classifier for AccessDenied. Timeout is
        // still message-matched because there is no SDK error code for it
        // (the fetcher layer throws a plain Error with "timed out" text).
        const reason =
          err instanceof Error && err.message.includes("timed out")
            ? " (timed out — your account may have many resources)"
            : isAccessDeniedError(err)
              ? " (missing IAM permission)"
              : "";
        clack.log.warn(
          `Could not discover ${field.question.label ?? field.name} from your account${reason}. Enter manually or leave blank for defaults.`,
        );
        warnedKeys.add(key);
        fetchResults.set(key, []);
      }
    }),
  );

  return fields.map((field) => {
    if (!field.question.fetcher) return field;
    const key = fieldFetchKey(field);
    const options = fetchResults.get(key) ?? [];

    if (options.length === 0) {
      // Check if the field has static fallback options defined in the plugin
      const staticOptions = field.question.options;
      const hasStaticFallback =
        Array.isArray(staticOptions) && staticOptions.length > 0;

      if (hasStaticFallback) {
        // Static defaults exist — show them with an outdated-data warning
        if (!warnedKeys.has(key)) {
          clack.log.warn(
            "Could not reach AWS. Showing default options \u2014 versions may be outdated.",
          );
        }
        return {
          ...field,
          question: {
            ...field.question,
            // Keep the existing static options; clear fetcher so we don't retry
            fetcher: undefined,
          },
        };
      }

      // No static fallback — revert to manual string entry.
      // Only warn if the catch block didn't already warn for this field.
      if (!warnedKeys.has(key)) {
        clack.log.warn(
          `Could not discover ${field.question.label ?? field.name} from your account. Enter manually.`,
        );
      }
      return {
        ...field,
        question: {
          ...field.question,
          type: "string" as const,
          options: undefined,
          fetcher: undefined,
        },
      };
    }

    return {
      ...field,
      question: {
        ...field.question,
        options,
      },
    };
  });
}
