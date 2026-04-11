/**
 * Wizard Interaction Matrix — Fetcher Discovery Coverage.
 *
 * For every plugin that defines a `fetcher` field, verify that:
 *
 *   1. **Empty discovery results → graceful fallback.** When the AWS
 *      discovery function returns `[]`, `resolveDynamicFields` either
 *      switches the field to `string` (manual entry) or keeps the static
 *      fallback options if the plugin defined any. The matrix MUST not
 *      crash on empty results.
 *
 *   2. **Populated discovery results → enum options replaced.** When the
 *      discovery function returns real options, `resolveDynamicFields`
 *      should populate `field.question.options` with the discovered values
 *      and clear the `fetcher` marker (so the option-elicitor doesn't
 *      try to re-fetch).
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #11
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceField, ResourcePlugin } from "@assignee/core";
import { PLUGINS_WITH_FETCHERS } from "./fixtures/wizard-matrix-plugins.js";

// Mock aws-resource-discovery so we can control fetcher return values per test.
// We re-mock per-test (via vi.mocked(...).mockResolvedValue) so each fetcher
// can be exercised in both empty and populated states.
vi.mock("../utils/aws-resource-discovery.js", () => ({
  discoverAmis: vi.fn().mockResolvedValue([]),
  discoverSubnets: vi.fn().mockResolvedValue([]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([]),
  discoverKeyPairs: vi.fn().mockResolvedValue([]),
  discoverInstanceTypes: vi.fn().mockResolvedValue(null),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([]),
  discoverLambdaRuntimes: vi.fn().mockResolvedValue([]),
  resolveAmiFromOsName: vi.fn().mockResolvedValue(null),
  clearDiscoveryCache: vi.fn(),
  DiscoveryCacheKey: {
    AMIS: "discover-amis",
    SUBNETS: "discover-subnets",
    KEY_PAIRS: "discover-key-pairs",
    SECURITY_GROUPS: "discover-security-groups",
    RDS_ENGINE_VERSIONS: "discover-rds-engine-versions",
    RDS_INSTANCE_CLASSES: "discover-rds-instance-classes",
    LAMBDA_RUNTIMES: "discover-lambda-runtimes",
  },
}));

// Silence clack warnings from inside resolveDynamicFields when discovery
// returns empty (the warn message is verified by user-facing tests
// elsewhere; here we only care about the data flow).
vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  isCancel: vi.fn(() => false),
}));

const { resolveDynamicFields } = await import("../utils/wizard-helpers.js");
const discoveryModule = await import("../utils/aws-resource-discovery.js");

/**
 * Set of fetcher IDs that are registered in the production `fetcherMap`
 * inside `wizard-helpers.ts`. IDs outside this set (e.g. "discover-vpcs",
 * "discover-availability-zones" — referenced by some plugin definitions
 * but not yet implemented) take a different code path inside
 * `resolveDynamicFields` (the field is left untouched). The fallback test
 * must NOT lump these together with the registered ones, otherwise a
 * regression where every fetcher silently stops being called would still
 * pass.
 */
const REGISTERED_FETCHER_IDS = new Set<string>([
  "discover-amis",
  "discover-subnets",
  "discover-security-groups",
  "discover-key-pairs",
  "discover-rds-engine-versions",
  "discover-rds-instance-classes",
  "discover-lambda-runtimes",
]);

/** Map fetcher ID → discovery function for the test runner. */
const fetcherFnByCacheKey: Record<string, ReturnType<typeof vi.fn>> = {
  "discover-amis": vi.mocked(discoveryModule.discoverAmis),
  "discover-subnets": vi.mocked(discoveryModule.discoverSubnets),
  "discover-security-groups": vi.mocked(discoveryModule.discoverSecurityGroups),
  "discover-key-pairs": vi.mocked(discoveryModule.discoverKeyPairs),
  "discover-rds-engine-versions": vi.mocked(
    discoveryModule.discoverRdsEngineVersions,
  ),
  "discover-rds-instance-classes": vi.mocked(
    discoveryModule.discoverRdsInstanceClasses,
  ),
  "discover-lambda-runtimes": vi.mocked(discoveryModule.discoverLambdaRuntimes),
};

/** Realistic sample options per fetcher ID (matches DiscoveryOption shape). */
const samplePopulatedByCacheKey: Record<
  string,
  Array<{ value: string; label: string }>
> = {
  "discover-amis": [
    { value: "ami-0abc1234567890abc", label: "Amazon Linux 2023 (x86_64)" },
    { value: "ami-0def4567890123def", label: "Ubuntu 22.04 LTS (x86_64)" },
  ],
  "discover-subnets": [
    {
      value: "subnet-0a1b2c3d4e5f6789a",
      label: "subnet-0a1b2c3d4e5f6789a (us-east-1a)",
    },
  ],
  "discover-security-groups": [
    { value: "sg-0fedcba9876543210", label: "default-vpc-sg (default)" },
  ],
  "discover-key-pairs": [{ value: "my-keypair", label: "my-keypair" }],
  "discover-rds-engine-versions": [
    { value: "16.3", label: "PostgreSQL 16.3" },
    { value: "15.7", label: "PostgreSQL 15.7" },
  ],
  "discover-rds-instance-classes": [
    { value: "db.t3.micro", label: "db.t3.micro (1 vCPU, 1 GiB)" },
  ],
  "discover-lambda-runtimes": [
    { value: "nodejs22.x", label: "Node.js 22.x" },
    { value: "python3.13", label: "Python 3.13" },
  ],
};

/** Collect all fetcher fields across both tiers. */
function fetcherFields(plugin: ResourcePlugin): ResourceField[] {
  return [...plugin.commonFields, ...plugin.advancedFields].filter(
    (f) => f.question.fetcher !== undefined,
  );
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so mockResolvedValue set in one
  // describe.each row does not bleed into the next.
  vi.resetAllMocks();
  // Re-arm every fetcher mock to its default empty state — resetAllMocks
  // wipes the mockResolvedValue we set at module load.
  for (const fn of Object.values(fetcherFnByCacheKey)) {
    fn.mockResolvedValue([]);
  }
});

describe.each(PLUGINS_WITH_FETCHERS.map((p) => [p.resourceType, p] as const))(
  "fetcher discovery — %s",
  (_resourceType, plugin) => {
    const fields = fetcherFields(plugin);

    it(`declares at least one fetcher field`, () => {
      expect(fields.length).toBeGreaterThan(0);
    });

    it("falls back gracefully when discovery returns empty results", async () => {
      const allFields = [...plugin.commonFields, ...plugin.advancedFields];
      const resolved = await resolveDynamicFields(allFields, {});

      // Every fetcher field must still be present in the resolved output.
      // resolveDynamicFields handles both registered and unregistered
      // fetcher IDs the same way when results are empty: drop the fetcher
      // marker, then either keep static fallback options (enum) or revert
      // to manual string entry. We assert the post-condition strictly:
      // the fetcher marker must be cleared and the type must be one of
      // {original (when static fallback exists), "string"}.
      for (const original of fields) {
        const after = resolved.find((f) => f.name === original.name);
        expect(after).toBeDefined();
        // Fetcher marker must be cleared so the option-elicitor doesn't
        // re-fetch on a subsequent loop iteration.
        expect(after?.question.fetcher).toBeUndefined();

        const hasStaticFallback =
          Array.isArray(original.question.options) &&
          original.question.options.length > 0;

        if (hasStaticFallback) {
          expect(after?.question.type).toBe(original.question.type);
          // Options must still be the original static set (count preserved).
          expect((after?.question.options ?? []).length).toBe(
            original.question.options!.length,
          );
        } else {
          // Reverted to string for manual entry. We assert the exact target
          // type rather than `oneOf(...)` so a regression that leaves the
          // type as enum-with-no-options (a wizard crash) is caught.
          expect(after?.question.type).toBe("string");
        }
      }
    });

    it("populates options when discovery returns real results", async () => {
      // Wire each registered fetcher to a populated sample. Unregistered
      // fetcher IDs are exempt — they're tested by the graceful-fallback
      // test above.
      const registeredFetcherFields = fields.filter((f) =>
        REGISTERED_FETCHER_IDS.has(f.question.fetcher!),
      );
      if (registeredFetcherFields.length === 0) {
        // Plugin has fetchers but none are registered — nothing to test
        // here. graceful-fallback covers it.
        return;
      }

      for (const field of registeredFetcherFields) {
        const id = field.question.fetcher!;
        // Force a fixture update if a new registered fetcher is added
        // without a sample — silently skipping is what the Edge Case Hunter
        // review caught and we explicitly fix here.
        expect(
          samplePopulatedByCacheKey,
          `wizard-matrix-fetchers fixture missing sample for fetcher ${id}`,
        ).toHaveProperty(id);
        const fn = fetcherFnByCacheKey[id]!;
        fn.mockResolvedValue(samplePopulatedByCacheKey[id]!);
      }

      const allFields = [...plugin.commonFields, ...plugin.advancedFields];
      const resolved = await resolveDynamicFields(allFields, {});

      for (const original of registeredFetcherFields) {
        const id = original.question.fetcher!;
        const sample = samplePopulatedByCacheKey[id]!;

        const after = resolved.find((f) => f.name === original.name);
        expect(after).toBeDefined();
        const opts = after?.question.options ?? [];
        expect(opts.length).toBeGreaterThanOrEqual(sample.length);
        for (const sampleOpt of sample) {
          expect(opts.some((o) => o.value === sampleOpt.value)).toBe(true);
        }
      }
    });
  },
);
