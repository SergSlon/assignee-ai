/**
 * ResourceDiscoveryPort — hexagonal-architecture boundary for existing-resource
 * discovery at intent-parse time.
 *
 * EPIC-107-2 (PH1-G-2 deep fix): backs the existing-resource-extractor node.
 *
 * Architecture decision (Winston, 2026-05-15):
 *   Production impl wraps the existing direct-SDK aws-resource-discovery module
 *   (Option D). No new MCP servers. No new cache infrastructure. Reader-cred
 *   isolation is inherited from the existing module's `createEc2Client()` etc.
 *
 * Test boundary: tests mock the entire port via
 *   `vi.mock("../../services/resource-discovery-port.js", () => ({
 *     productionResourceDiscoveryPort: vi.fn().mockReturnValue({ ... }),
 *   }))`.
 */

import { log, LOG_ACTIONS } from "../utils/logger/index.js";
import {
  discoverVpcs,
  discoverDbSubnetGroups,
  discoverEcsClusters,
  discoverElbs,
} from "../utils/aws-resource-discovery/index.js";
import type { DiscoveryOption } from "../utils/aws-resource-discovery/types.js";

/**
 * A single existing AWS resource discovered at intent-parse time.
 * Read-only — never mutated by plan/apply/destroy.
 *
 * Destroy isolation (Variation F, EPIC-107-2): ExistingResource entries live
 * in `graph-state.existingResources`, which the destroy strategies NEVER
 * iterate. Destroy iterates `ManagedResource` from provisions.json only.
 */
export interface ExistingResource {
  /** Resource kind — "VPC" | "SubnetGroup" | "EcsCluster" | "Elb" */
  kind: string;
  /** Primary identifier (CCAPI-style: VPC ID, cluster name, ARN, etc.) */
  id: string;
  /**
   * Human-readable display label. Embeds Name-tag and other discriminating
   * tag fragments when present (e.g. "staging (vpc-staging, 10.0.0.0/16)").
   * `tagSubstringAutoSelect` reads this field for disambiguation — there is
   * no separate `tags` map because `DiscoveryOption` only carries
   * `{ value, label }`. If a future story needs raw tags, extend
   * `DiscoveryOption` and the SDK helpers in lockstep.
   */
  label: string;
  /** AWS region where the resource lives. */
  region: string;
}

/**
 * Port interface: one method per resource kind supported by the
 * existing-resource-extractor. Add new methods as patterns demand.
 *
 * Every method returns a promise of zero-or-more existing resources.
 * Failure MUST be caught by the impl and return [] — never throw.
 */
export interface ResourceDiscoveryPort {
  discoverVpcs(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverSubnetGroups(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverEcsClusters(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverElbs(opts: { region?: string }): Promise<ExistingResource[]>;
}

// ─── shape-mapper ────────────────────────────────────────────────────────────

function mapOption(
  opt: DiscoveryOption,
  kind: string,
  region: string,
): ExistingResource {
  return {
    kind,
    id: opt.value,
    label: opt.label,
    region,
  };
}

// ─── Production implementation ────────────────────────────────────────────────

/**
 * Production impl that wraps the existing aws-resource-discovery module.
 * Each method catches errors and returns [] so the intent-parser never crashes.
 * Callsite token is "intent-parser/existing-resource-extractor" for per-call
 * auditability (feedback_token_cost_visibility).
 *
 * EPIC-107-2 R2:
 *   - `region` is plumbed end-to-end (factory → fetcher → SDK client AND
 *     cache key). Per-call `opts.region` overrides the factory default,
 *     so callers can re-target a different region without rebuilding the
 *     port (e.g. multi-region planners in a future story).
 *   - `runId` is captured from the factory so DISCOVERY_FAILURE log lines
 *     correlate with the rest of the plan trace (was previously the
 *     literal "discovery").
 *
 * @param region — default AWS region (overridable per-call via opts.region).
 * @param runId  — graph-state runId for log correlation.
 */
export function productionResourceDiscoveryPort(
  region: string,
  runId: string = "discovery",
): ResourceDiscoveryPort {
  const callsite = "intent-parser/existing-resource-extractor";

  async function safeFetch(
    kind: string,
    effectiveRegion: string,
    fetcher: (r?: string) => Promise<DiscoveryOption[]>,
  ): Promise<ExistingResource[]> {
    try {
      const opts = await fetcher(effectiveRegion);
      return opts.map((o) => mapOption(o, kind, effectiveRegion));
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.DISCOVERY_FAILURE,
        extras: {
          callsite,
          kind,
          region: effectiveRegion,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return [];
    }
  }

  return {
    discoverVpcs: async (opts) =>
      safeFetch("VPC", opts.region ?? region, discoverVpcs),
    discoverSubnetGroups: async (opts) =>
      safeFetch("SubnetGroup", opts.region ?? region, discoverDbSubnetGroups),
    discoverEcsClusters: async (opts) =>
      safeFetch("EcsCluster", opts.region ?? region, discoverEcsClusters),
    discoverElbs: async (opts) =>
      safeFetch("Elb", opts.region ?? region, discoverElbs),
  };
}
