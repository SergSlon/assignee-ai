/**
 * Tests for existing-resource-extractor (EPIC-107-2, PH1-G-2 deep fix).
 *
 * Probe variations (all mock ResourceDiscoveryPort — zero real AWS calls):
 *
 *   A — discovery hit, single VPC     → existing node lands in result
 *   B — discovery hit, multiple VPCs  → needsElicitation=true (picker)
 *   B2 — tag-substring fast-path      → auto-select unique match, no picker
 *   C — discovery miss                → empty result, no advisory noise
 *   D — discovery failure (throws)    → empty result, no crash
 *   E — cache (handled at port level) → port called (extractor is stateless)
 *   F — destroy isolation             → existingResources NOT in ManagedResource set
 *   G — region scoping                → opts.region passed through to port
 */

import { describe, it, expect, vi } from "vitest";
import { extractExisting } from "./existing-resource-extractor.js";
import type {
  ResourceDiscoveryPort,
  ExistingResource,
} from "../../../../services/resource-discovery-port.js";

// ─── test fixtures ────────────────────────────────────────────────────────────

const VPC_DEFAULT: ExistingResource = {
  kind: "VPC",
  id: "vpc-abc123",
  label: "default (vpc-abc123, 172.31.0.0/16 [default])",
  region: "us-east-1",
};

const VPC_STAGING: ExistingResource = {
  kind: "VPC",
  id: "vpc-staging",
  label: "staging (vpc-staging, 10.0.0.0/16)",
  region: "us-east-1",
};

const VPC_PROD: ExistingResource = {
  kind: "VPC",
  id: "vpc-prod",
  label: "prod (vpc-prod, 10.1.0.0/16)",
  region: "us-east-1",
};

function makePort(
  overrides: Partial<ResourceDiscoveryPort> = {},
): ResourceDiscoveryPort {
  return {
    discoverVpcs: vi.fn().mockResolvedValue([]),
    discoverSubnetGroups: vi.fn().mockResolvedValue([]),
    discoverEcsClusters: vi.fn().mockResolvedValue([]),
    discoverElbs: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── Variation A: discovery hit, single VPC ────────────────────────────────

describe("extractExisting — Variation A (single VPC hit)", () => {
  it("returns the VPC in existing[] when intent mentions 'default vpc'", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_DEFAULT]),
    });
    const result = await extractExisting(
      "Create an EFS in my default VPC",
      port,
      "us-east-1",
    );
    expect(result.existing).toHaveLength(1);
    expect(result.existing[0]!.kind).toBe("VPC");
    expect(result.existing[0]!.id).toBe("vpc-abc123");
    expect(result.needsElicitation).toBe(false);
  });

  it("does NOT call discoverVpcs when intent has no VPC keyword", async () => {
    const port = makePort();
    await extractExisting(
      "Create an S3 bucket with versioning",
      port,
      "us-east-1",
    );
    expect(port.discoverVpcs).not.toHaveBeenCalled();
  });
});

// ─── Variation B: multiple VPC matches → elicitation ──────────────────────

describe("extractExisting — Variation B (multi-match → elicitation)", () => {
  it("sets needsElicitation=true and reports ambiguous kinds when intent matches multiple VPCs", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_STAGING, VPC_PROD]),
    });
    const result = await extractExisting(
      "RDS instance in my VPC",
      port,
      "us-east-1",
    );
    expect(result.needsElicitation).toBe(true);
    // R2 (review finding #4): existing[] is EMPTY for ambiguous kinds —
    // candidates are not pushed into graph state. The picker (when wired)
    // will read from `ambiguous[]` instead.
    expect(result.existing).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.kind).toBe("VPC");
    expect(result.ambiguous[0]!.candidates).toHaveLength(2);
  });
});

// ─── Variation B2: tag-substring fast-path ────────────────────────────────

describe("extractExisting — Variation B2 (tag-substring auto-select)", () => {
  it("auto-selects staging VPC when 'staging' in intent uniquely matches", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_STAGING, VPC_PROD]),
    });
    const result = await extractExisting(
      "RDS instance in my staging VPC",
      port,
      "us-east-1",
    );
    expect(result.needsElicitation).toBe(false);
    expect(result.existing).toHaveLength(1);
    expect(result.existing[0]!.id).toBe("vpc-staging");
  });

  // EPIC-107-2 R2 (review finding #3): the previous algorithm used `find()`
  // which picked the first-matching word. Quinn's example: an intent like
  // "rds in vpc with prod settings" where "rds" coincidentally only matches
  // one label by accident. The new algorithm excludes short kind-name
  // stopwords (rds, vpc, alb …) and requires high-confidence convergence.
  it("does NOT auto-select on stopword-only coincidence (kind name in label)", async () => {
    // Label-A contains "rds" by tag; Label-B does not. Intent says "rds"
    // (which is a STOPWORD now). With the old algorithm, the find() would
    // return "rds", and the auto-selector would pick Label-A. With the new
    // algorithm, "rds" is filtered out as a stopword → no unique-match
    // word → fall through to ambiguous.
    const VPC_WITH_RDS_TAG: ExistingResource = {
      kind: "VPC",
      id: "vpc-rds-host",
      label: "rds-host (vpc-rds-host, 10.5.0.0/16)",
      region: "us-east-1",
    };
    const VPC_PLAIN: ExistingResource = {
      kind: "VPC",
      id: "vpc-plain",
      label: "plain (vpc-plain, 10.6.0.0/16)",
      region: "us-east-1",
    };
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_WITH_RDS_TAG, VPC_PLAIN]),
    });
    const result = await extractExisting(
      "create rds in vpc",
      port,
      "us-east-1",
    );
    // Stopwords-only → no auto-select → ambiguous
    expect(result.needsElicitation).toBe(true);
    expect(result.existing).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
  });

  it("returns null when two unique-match words point at DIFFERENT candidates (Quinn's asymmetric case)", async () => {
    // Asymmetric: "staging" uniquely matches vpc-staging-net; "metrics"
    // uniquely matches vpc-metrics-only. Intent has BOTH → the old
    // algorithm picks whichever appears first; new algorithm bails to
    // ambiguous because matchedIds.size > 1.
    const VPC_STAGING_NET: ExistingResource = {
      kind: "VPC",
      id: "vpc-staging-net",
      label: "staging-net (vpc-staging-net, 10.0.0.0/16)",
      region: "us-east-1",
    };
    const VPC_METRICS_ONLY: ExistingResource = {
      kind: "VPC",
      id: "vpc-metrics-only",
      label: "metrics-only (vpc-metrics-only, 10.1.0.0/16)",
      region: "us-east-1",
    };
    const port = makePort({
      discoverVpcs: vi
        .fn()
        .mockResolvedValue([VPC_STAGING_NET, VPC_METRICS_ONLY]),
    });
    const result = await extractExisting(
      "deploy service to my staging vpc with metrics",
      port,
      "us-east-1",
    );
    expect(result.needsElicitation).toBe(true);
    expect(result.existing).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.candidates).toHaveLength(2);
  });
});

// ─── Variation C: discovery miss ──────────────────────────────────────────

describe("extractExisting — Variation C (discovery miss)", () => {
  it("returns empty result when port returns [] (no VPCs exist)", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([]),
    });
    const result = await extractExisting(
      "Create an EFS in the default VPC",
      port,
      "us-east-1",
    );
    expect(result.existing).toHaveLength(0);
    expect(result.needsElicitation).toBe(false);
  });
});

// ─── Variation D: discovery failure ───────────────────────────────────────

describe("extractExisting — Variation D (discovery failure)", () => {
  it("returns empty result when port throws — no crash", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockRejectedValue(new Error("MCPUnreachableError")),
    });
    const result = await extractExisting(
      "Create an EFS in the default VPC",
      port,
      "us-east-1",
    );
    expect(result.existing).toHaveLength(0);
    expect(result.needsElicitation).toBe(false);
  });
});

// ─── Variation F: destroy isolation ───────────────────────────────────────

describe("extractExisting — Variation F (destroy isolation)", () => {
  /**
   * Core invariant: ExistingResource[] returned by extractExisting is a
   * read-only data structure. It does NOT implement the ManagedResource
   * interface (no `resourceArn`, no `resourceType` CFN string, no
   * `provisions` timestamp). Destroy strategies iterate ManagedResource[]
   * from provisions.json — they NEVER see ExistingResource entries.
   *
   * This test asserts the shape boundary explicitly so a reviewer can
   * verify the invariant at file:line level.
   */
  it("ExistingResource shape does NOT have resourceArn or provisions fields (destroy cannot target it)", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_DEFAULT]),
    });
    const result = await extractExisting(
      "Create an EFS in the default VPC",
      port,
      "us-east-1",
    );
    const er = result.existing[0]!;
    // Verify required ExistingResource fields are present
    expect(er.kind).toBe("VPC");
    expect(er.id).toBe("vpc-abc123");
    expect(er.region).toBe("us-east-1");
    // Verify ManagedResource-specific fields are ABSENT
    expect("resourceArn" in er).toBe(false);
    expect("provisionedAt" in er).toBe(false);
    expect("provisions" in er).toBe(false);
  });

  it("existingResources field is a separate array from ManagedResource — destroy cannot reach it", async () => {
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_DEFAULT]),
    });
    const { existing } = await extractExisting(
      "Create an EFS in the default VPC",
      port,
      "us-east-1",
    );
    // The destroy bulk-action calls fetchManagedResources(), which reads
    // provisions.json — completely separate from graph-state.existingResources.
    // This test demonstrates the type boundary: ExistingResource has no
    // delete/destroy methods.
    expect(typeof (existing[0] as { destroy?: unknown }).destroy).toBe(
      "undefined",
    );
  });
});

// ─── Variation G: region scoping ──────────────────────────────────────────

describe("extractExisting — Variation G (region scoping)", () => {
  it("passes the region parameter through to port methods", async () => {
    const discoverVpcs = vi.fn().mockResolvedValue([]);
    const port = makePort({ discoverVpcs });
    await extractExisting(
      "Create an EFS in the default VPC",
      port,
      "eu-west-1",
    );
    expect(discoverVpcs).toHaveBeenCalledWith({ region: "eu-west-1" });
  });
});

// ─── multi-kind discovery ─────────────────────────────────────────────────

describe("extractExisting — multi-kind (VPC + ECS cluster)", () => {
  it("discovers both VPC and ECS cluster when intent mentions both", async () => {
    const ECS_CLUSTER: ExistingResource = {
      kind: "EcsCluster",
      id: "my-cluster",
      label: "my-cluster (2 services)",
      region: "us-east-1",
    };
    const port = makePort({
      discoverVpcs: vi.fn().mockResolvedValue([VPC_DEFAULT]),
      discoverEcsClusters: vi.fn().mockResolvedValue([ECS_CLUSTER]),
    });
    const result = await extractExisting(
      "Create an ECS service in my default VPC and existing cluster",
      port,
      "us-east-1",
    );
    expect(result.existing).toHaveLength(2);
    const kinds = result.existing.map((r) => r.kind).sort();
    expect(kinds).toEqual(["EcsCluster", "VPC"]);
  });
});
