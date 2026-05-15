/**
 * Tests for EPIC-107-2 R1 (review finding #3): when extractExisting returns
 * `needsElicitation=true`, the intent-parser node MUST surface a non-blocking
 * advisory (code: EXISTING_RESOURCE_AMBIGUOUS) into `state.advisories` so the
 * plan card warns the user that multiple existing resources matched.
 *
 * Without this advisory the user sees "Found existing VPC: vpc-staging" AND
 * "Found existing VPC: vpc-prod" with no indication that a choice is needed.
 *
 * Mocks `productionResourceDiscoveryPort` to return 2 VPCs ambiguously.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockLlmAdapter } from "../../../../testing/index.js";
import type { AgentState } from "../../../graph-state.js";

// Hoisted mocks so the import order below uses them.
const portMocks = vi.hoisted(() => ({
  productionResourceDiscoveryPort: vi.fn(),
}));

vi.mock("../../../../services/resource-discovery-port.js", () => ({
  productionResourceDiscoveryPort: portMocks.productionResourceDiscoveryPort,
}));

// Import AFTER vi.mock so the intent-parser node picks up the mocked port.
const { createIntentParserNode } = await import("../index.js");

describe("intentParserNode — EPIC-107-2 R1 (multi-match advisory)", () => {
  beforeEach(() => {
    portMocks.productionResourceDiscoveryPort.mockReset();
  });

  it("appends EXISTING_RESOURCE_AMBIGUOUS advisory when multiple VPCs match", async () => {
    // Mock port returns 2 VPCs — neither label uniquely matches any word in
    // the intent ('rds instance in my vpc' has no 'staging' or 'prod') so
    // tagSubstringAutoSelect returns null → needsElicitation=true.
    portMocks.productionResourceDiscoveryPort.mockReturnValue({
      discoverVpcs: vi.fn().mockResolvedValue([
        {
          kind: "VPC",
          id: "vpc-staging",
          label: "staging (vpc-staging, 10.0.0.0/16)",
          region: "us-east-1",
        },
        {
          kind: "VPC",
          id: "vpc-prod",
          label: "prod (vpc-prod, 10.1.0.0/16)",
          region: "us-east-1",
        },
      ]),
      discoverSubnetGroups: vi.fn().mockResolvedValue([]),
      discoverEcsClusters: vi.fn().mockResolvedValue([]),
      discoverElbs: vi.fn().mockResolvedValue([]),
    });

    const mock = new MockLlmAdapter({ resourceType: "AWS::RDS::DBInstance" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "create an RDS instance in my VPC",
      runId: "epic-107-2-r1-advisory-test",
    } as AgentState;

    const result = await node(state);

    // R2 (review finding #4): ambiguous candidates are DROPPED from
    // existing[] so graph state isn't polluted with N "Found existing"
    // lines that have no commitment.
    expect(result.existingResources ?? []).toHaveLength(0);

    // The R2 advisory landed in state.advisories
    expect(result.advisories).toBeDefined();
    const ambiguityAdvisory = result.advisories?.find(
      (a) => a.code === "EXISTING_RESOURCE_AMBIGUOUS",
    );
    expect(ambiguityAdvisory).toBeDefined();
    expect(ambiguityAdvisory?.message).toContain("Multiple existing resources");
    expect(ambiguityAdvisory?.hint).toContain("distinguishing name fragment");
    // Details include the ambiguous-kinds breakdown for downstream
    // consumers / picker wiring (deferred).
    expect(ambiguityAdvisory?.details).toBeDefined();
    expect(
      (ambiguityAdvisory!.details as { ambiguousKinds: unknown[] })
        .ambiguousKinds,
    ).toHaveLength(1);
  });

  it("does NOT emit advisory when discovery returns a single unique VPC", async () => {
    portMocks.productionResourceDiscoveryPort.mockReturnValue({
      discoverVpcs: vi.fn().mockResolvedValue([
        {
          kind: "VPC",
          id: "vpc-default",
          label: "default (vpc-default, 172.31.0.0/16 [default])",
          region: "us-east-1",
        },
      ]),
      discoverSubnetGroups: vi.fn().mockResolvedValue([]),
      discoverEcsClusters: vi.fn().mockResolvedValue([]),
      discoverElbs: vi.fn().mockResolvedValue([]),
    });

    const mock = new MockLlmAdapter({ resourceType: "AWS::EFS::FileSystem" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "create an EFS in my default VPC",
      runId: "epic-107-2-r1-advisory-single-test",
    } as AgentState;

    const result = await node(state);

    expect(result.existingResources).toHaveLength(1);
    const ambiguityAdvisory = result.advisories?.find(
      (a) => a.code === "EXISTING_RESOURCE_AMBIGUOUS",
    );
    expect(ambiguityAdvisory).toBeUndefined();
  });

  it("does NOT emit advisory when no resources discovered", async () => {
    portMocks.productionResourceDiscoveryPort.mockReturnValue({
      discoverVpcs: vi.fn().mockResolvedValue([]),
      discoverSubnetGroups: vi.fn().mockResolvedValue([]),
      discoverEcsClusters: vi.fn().mockResolvedValue([]),
      discoverElbs: vi.fn().mockResolvedValue([]),
    });

    const mock = new MockLlmAdapter({ resourceType: "AWS::S3::Bucket" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "create an S3 bucket",
      runId: "epic-107-2-r1-advisory-none-test",
    } as AgentState;

    const result = await node(state);

    expect(result.existingResources).toBeUndefined();
    const ambiguityAdvisory = result.advisories?.find(
      (a) => a.code === "EXISTING_RESOURCE_AMBIGUOUS",
    );
    expect(ambiguityAdvisory).toBeUndefined();
  });
});
