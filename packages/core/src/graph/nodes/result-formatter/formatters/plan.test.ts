/**
 * Epic 92 Wave 4 (e92.4.a) tests — plan formatter sanitation helpers.
 * Story 108-B-03 tests — formatCostBlock, parseCostLabelFallback, setCostDetailEnabled.
 *
 * Registry-driven axes (Story 108-B-03 F2): Axes VM-A and VM-G use
 * enumerateTypes() from the variant-matrix harness to iterate all supported
 * types rather than hardcoding a fixed sample.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { ProcessEnvConfigAdapter } from "@/config/config-port.js";
import {
  sanitizeDesiredState,
  normalizeMemoryHints,
  emitExistingResourceLines,
  formatCostBlock,
  parseCostLabelFallback,
  setCostDetailEnabled,
  getCostDetailEnabled,
} from "./plan.js";
import type { ExistingResource } from "@/services/resource-discovery-port.js";
// Story 108-B-03 F2: variant-matrix harness for registry-driven axes.
import { enumerateTypes } from "../../../../__tests__/variant-matrix/index.js";
import { defaultDecomposerRegistry } from "../../../../pricing/barrels/decomposers.js";

vi.mock("@/utils/display.js", () => ({
  renderPlanBox: vi.fn(),
  renderCostBlock: vi.fn(),
  promptFixSelection: vi.fn().mockResolvedValue(null),
}));

// Story 108-B-03: mock token-usage so tests are deterministic.
vi.mock("@/utils/token-usage.js", () => ({
  getTokenUsageSummary: vi.fn(() => ({ totalTokens: 1234, byCallsite: {} })),
  resetTokenUsage: vi.fn(),
  recordTokenUsage: vi.fn(),
}));

describe("sanitizeDesiredState (Epic 92 Wave 4.a / A-19)", () => {
  it("drops rows with empty-string values", () => {
    const input = {
      InstanceType: "t3.micro",
      CPUCredits: "",
      ImageId: "ami-0abc1234def567890",
    };
    const result = sanitizeDesiredState(input);
    expect(result).toEqual({
      InstanceType: "t3.micro",
      ImageId: "ami-0abc1234def567890",
    });
  });

  it("drops rows with undefined values", () => {
    const input = { InstanceType: "t3.micro", KeyName: undefined };
    const result = sanitizeDesiredState(input);
    expect(result).toEqual({ InstanceType: "t3.micro" });
    expect(Object.prototype.hasOwnProperty.call(result, "KeyName")).toBe(false);
  });

  it("drops rows with null values", () => {
    const input = { InstanceType: "t3.micro", SubnetId: null };
    expect(sanitizeDesiredState(input)).toEqual({ InstanceType: "t3.micro" });
  });

  it("preserves boolean false (deliberate disabled flag)", () => {
    const input = { EbsOptimized: false, Monitoring: true };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("preserves numeric zero", () => {
    const input = { MinCount: 0, VolumeSize: 8 };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("preserves empty arrays and empty objects", () => {
    const input = { Tags: [], BlockDeviceMappings: [], Metadata: {} };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("returns empty object when input is an empty object", () => {
    expect(sanitizeDesiredState({})).toEqual({});
  });

  it("returns undefined when input is undefined", () => {
    expect(sanitizeDesiredState(undefined)).toBeUndefined();
  });

  it("handles mixed values in a single pass", () => {
    const input = {
      InstanceType: "t3.micro",
      CPUCredits: "",
      Monitoring: false,
      SubnetId: null,
      Tags: [],
      KeyName: undefined,
      ImageId: "ami-0abc1234def567890",
    };
    expect(sanitizeDesiredState(input)).toEqual({
      InstanceType: "t3.micro",
      Monitoring: false,
      Tags: [],
      ImageId: "ami-0abc1234def567890",
    });
  });
});

describe("normalizeMemoryHints (Epic 92 Wave 4.a / A-19 / D-35)", () => {
  it("collapses duplicate /month suffix on S3 GB-month hints", () => {
    expect(
      normalizeMemoryHints([
        "Previous provision of this type: $0.0230/GB-month/month (run abc, 4/15/2026).",
      ]),
    ).toEqual([
      "Previous provision of this type: $0.0230/GB-month (run abc, 4/15/2026).",
    ]);
  });

  it("collapses duplicate /mo suffix on Lambda monthly hints", () => {
    expect(normalizeMemoryHints(["Previous provision: $3.00/mo/mo"])).toEqual([
      "Previous provision: $3.00/mo",
    ]);
  });

  it("collapses mixed /month/mo (first wins)", () => {
    expect(normalizeMemoryHints(["Previous provision: $5/month/mo"])).toEqual([
      "Previous provision: $5/month",
    ]);
  });

  it("collapses mixed /mo/month (first wins)", () => {
    expect(normalizeMemoryHints(["Previous provision: $5/mo/month"])).toEqual([
      "Previous provision: $5/mo",
    ]);
  });

  it("collapses triple-repeat $N/mo/mo/mo via repeated passes", () => {
    expect(normalizeMemoryHints(["$7.50/mo/mo/mo"])).toEqual(["$7.50/mo"]);
  });

  it("passes already-clean lines through unchanged", () => {
    const input = [
      "Previous provision: $3.00/mo",
      "Previous provision: $0.0230/GB-month",
      "Previous provision: Free",
    ];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("preserves the comma/period/paren trailing punctuation", () => {
    expect(normalizeMemoryHints(["$0.0230/GB-month/month, run abc."])).toEqual([
      "$0.0230/GB-month, run abc.",
    ]);
  });

  it("does not touch URL-like paths (no whitespace boundary)", () => {
    const input = ["See https://example.com/month/api for details"];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("leaves single /month / /mo suffixes intact", () => {
    const input = ["Previous provision: $3.00/month"];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeMemoryHints(undefined)).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(normalizeMemoryHints([])).toEqual([]);
  });

  it("normalizes each hint in a multi-hint array", () => {
    expect(
      normalizeMemoryHints([
        "$1.00/mo/mo",
        "Failures: 2 in last 24h",
        "$0.0230/GB-month/month",
      ]),
    ).toEqual(["$1.00/mo", "Failures: 2 in last 24h", "$0.0230/GB-month"]);
  });
});

describe("emitExistingResourceLines (EPIC-107-2)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  const vpcResource: ExistingResource = {
    kind: "VPC",
    id: "vpc-abc123",
    label: "default (vpc-abc123, 172.31.0.0/16 [default])",
    region: "us-east-1",
  };

  it("emits 'Found existing <kind>: <id> (<region>)' for each resource", () => {
    emitExistingResourceLines([vpcResource]);
    expect(stdoutSpy).toHaveBeenCalledWith(
      "Found existing VPC: vpc-abc123 (us-east-1)\n",
    );
  });

  it("emits nothing when existingResources is empty", () => {
    emitExistingResourceLines([]);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("emits nothing when existingResources is undefined", () => {
    emitExistingResourceLines(undefined);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("emits one line per resource for multiple entries", () => {
    const ecsResource: ExistingResource = {
      kind: "EcsCluster",
      id: "my-cluster",
      label: "my-cluster (2 services)",
      region: "eu-west-1",
    };
    emitExistingResourceLines([vpcResource, ecsResource]);
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenNthCalledWith(
      1,
      "Found existing VPC: vpc-abc123 (us-east-1)\n",
    );
    expect(stdoutSpy).toHaveBeenNthCalledWith(
      2,
      "Found existing EcsCluster: my-cluster (eu-west-1)\n",
    );
  });
});

describe("formatPlanResult JSON output (Epic 92 Wave 4.a)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let captured: string;

  beforeEach(() => {
    captured = "";
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        captured += String(chunk);
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function makeState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      userIntent: "create an ec2 instance",
      runId: "e92-4a-test-run",
      executionMode: ExecutionMode.PLAN,
      executionStatus: ExecutionStatus.PENDING,
      outputFormat: "json",
      resourceType: "AWS::EC2::Instance",
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
      messages: [],
      // RW4b-3: ConfigPort threaded through state — buildPlanJsonPayload
      // reads `state.config` for region resolution.
      config: new ProcessEnvConfigAdapter(),
      ...overrides,
    } as AgentState;
  }

  it("strips empty-valued rows from desiredState in JSON payload (A-19)", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(
      makeState({
        desiredState: {
          InstanceType: "t3.micro",
          CPUCredits: "",
          ImageId: "ami-0abc1234def567890",
          KeyName: undefined,
        },
      }),
    );
    const payload = JSON.parse(captured.trim()) as {
      desiredState: Record<string, unknown>;
    };
    expect(payload.desiredState).toEqual({
      InstanceType: "t3.micro",
      ImageId: "ami-0abc1234def567890",
    });
  });

  it("preserves boolean false and numeric zero in JSON payload", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(
      makeState({
        desiredState: {
          InstanceType: "t3.micro",
          EbsOptimized: false,
          MinCount: 0,
        },
      }),
    );
    const payload = JSON.parse(captured.trim()) as {
      desiredState: Record<string, unknown>;
    };
    expect(payload.desiredState).toEqual({
      InstanceType: "t3.micro",
      EbsOptimized: false,
      MinCount: 0,
    });
  });

  it("emits null for desiredState when state has no desiredState", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(makeState({ desiredState: undefined }));
    const payload = JSON.parse(captured.trim()) as { desiredState: unknown };
    expect(payload.desiredState).toBeNull();
  });

  it("Story 108-B-03: JSON payload includes costBlock field (Axis D)", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(
      makeState({
        pricingBreakdown: {
          fixedItems: [],
          usageBasedItems: [],
          fixedSubtotal: 32.85,
          fetchedAt: new Date().toISOString(),
          hasCacheHits: false,
          hasPartialFailure: false,
        },
        estimatedMonthlyCost: "~$32.85/mo",
        desiredState: { InstanceType: "t3.medium" },
      }),
    );
    const payload = JSON.parse(captured.trim()) as {
      costBlock: {
        infraCostMonthly: number;
        bedrockTokens: number;
        unavailable: boolean;
      };
    };
    expect(payload.costBlock).toBeDefined();
    expect(payload.costBlock.infraCostMonthly).toBe(32.85);
    expect(payload.costBlock.bedrockTokens).toBe(1234);
    expect(payload.costBlock.unavailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 108-B-03 — parseCostLabelFallback (Axis C)
// ---------------------------------------------------------------------------

describe("parseCostLabelFallback (Story 108-B-03 Axis C)", () => {
  it("Axis C-1: parses standard ~$X.XX/mo format", () => {
    expect(parseCostLabelFallback("~$32.85/mo")).toBe(32.85);
  });

  it("Axis C-2: parses integer ~$N/mo format", () => {
    expect(parseCostLabelFallback("~$10/mo")).toBe(10);
  });

  it("Axis C-3: parses bare $X.XX/mo (no tilde)", () => {
    expect(parseCostLabelFallback("$5.00/mo")).toBe(5.0);
  });

  it("Axis C-4: returns null for 'Free'", () => {
    expect(parseCostLabelFallback("Free")).toBeNull();
  });

  it("Axis C-5: returns null for 'N/A'", () => {
    expect(parseCostLabelFallback("N/A")).toBeNull();
  });

  it("Axis C-6: returns null for undefined", () => {
    expect(parseCostLabelFallback(undefined)).toBeNull();
  });

  it("Axis C-7: returns null for empty string", () => {
    expect(parseCostLabelFallback("")).toBeNull();
  });

  it("Axis C-8: returns null for free-tier label", () => {
    expect(parseCostLabelFallback("Free tier applies")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Story 108-B-03 — setCostDetailEnabled / getCostDetailEnabled (Axis H)
// ---------------------------------------------------------------------------

describe("setCostDetailEnabled / getCostDetailEnabled (Story 108-B-03 Axis H)", () => {
  afterEach(() => {
    // Reset after each test so state doesn't bleed.
    setCostDetailEnabled(false);
  });

  it("Axis H-1: defaults to false", () => {
    expect(getCostDetailEnabled()).toBe(false);
  });

  it("Axis H-2: can be set to true", () => {
    setCostDetailEnabled(true);
    expect(getCostDetailEnabled()).toBe(true);
  });

  it("Axis H-3: can be toggled back to false", () => {
    setCostDetailEnabled(true);
    setCostDetailEnabled(false);
    expect(getCostDetailEnabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 108-B-03 — formatCostBlock (Axes A, B, E, F, G, I, J, K)
// ---------------------------------------------------------------------------

describe("formatCostBlock (Story 108-B-03)", () => {
  function makeMinimalState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      userIntent: "create an ec2 instance",
      runId: "b03-test-run",
      executionMode: ExecutionMode.PLAN,
      executionStatus: ExecutionStatus.PENDING,
      outputFormat: "text",
      resourceType: "AWS::EC2::Instance",
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
      messages: [],
      config: new ProcessEnvConfigAdapter(),
      ...overrides,
    } as AgentState;
  }

  // Axis A: Standard priced resource — primary source is pricingBreakdown.fixedSubtotal.
  it("Axis A: uses pricingBreakdown.fixedSubtotal as primary cost source", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 25.5,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      estimatedMonthlyCost: "~$99.00/mo", // should be ignored in favour of pricingBreakdown
    });
    const result = formatCostBlock(state);
    expect(result.infraCostMonthly).toBe(25.5);
    expect(result.unavailable).toBe(false);
    expect(result.bedrockTokens).toBe(1234);
  });

  // Axis B: No pricingBreakdown, estimatedMonthlyCost is a parseable string.
  it("Axis B: falls back to parseCostLabelFallback when pricingBreakdown absent", () => {
    const state = makeMinimalState({
      pricingBreakdown: undefined,
      estimatedMonthlyCost: "~$8.50/mo",
    });
    const result = formatCostBlock(state);
    expect(result.infraCostMonthly).toBe(8.5);
    expect(result.unavailable).toBe(false);
  });

  // Axis E: Free-tier resource — zero fixedSubtotal + freeTierNote present.
  it("Axis E: zero fixedSubtotal with freeTierNote → not unavailable, note propagated", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 0,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      freeTierNote: {
        message: "Free tier: 750 hrs/mo",
        type: "usage" as never,
      },
    });
    const result = formatCostBlock(state);
    expect(result.infraCostMonthly).toBe(0);
    expect(result.freeTierNote).toBe("Free tier: 750 hrs/mo");
    expect(result.unavailable).toBe(false);
  });

  // Axis F: estimatedMonthlyCost is "Free" (non-parseable) — should return null infraCostMonthly.
  it("Axis F: estimatedMonthlyCost='Free' with no pricingBreakdown → null infraCost", () => {
    const state = makeMinimalState({
      pricingBreakdown: undefined,
      estimatedMonthlyCost: "Free",
    });
    const result = formatCostBlock(state);
    expect(result.infraCostMonthly).toBeNull();
    expect(result.unavailable).toBe(false); // has a label, just not parseable
  });

  // Axis G: No pricing info at all → unavailable=true.
  it("Axis G: no pricingBreakdown and no estimatedMonthlyCost → unavailable=true", () => {
    const state = makeMinimalState({
      pricingBreakdown: undefined,
      estimatedMonthlyCost: undefined,
    });
    const result = formatCostBlock(state);
    expect(result.unavailable).toBe(true);
    expect(result.infraCostMonthly).toBeNull();
  });

  // Axis I: costDetail=false → perResourceBreakdown absent.
  it("Axis I: costDetail=false → no perResourceBreakdown", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 12.0,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      estimatedMonthlyCost: "~$12.00/mo",
      perResourceCosts: { "AWS::EC2::Instance": "~$12.00/mo" },
    });
    const result = formatCostBlock(state, { costDetail: false });
    expect(result.perResourceBreakdown).toBeUndefined();
  });

  // Axis J: costDetail=true + perResourceCosts → breakdown included.
  it("Axis J: costDetail=true with perResourceCosts → perResourceBreakdown populated", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 45.0,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      perResourceCosts: {
        "AWS::EC2::Instance": "~$30.00/mo",
        "AWS::RDS::DBInstance": "~$15.00/mo",
      },
    });
    const result = formatCostBlock(state, {
      costDetail: true,
      perResourceCosts: state.perResourceCosts,
    });
    expect(result.perResourceBreakdown).toBeDefined();
    expect(result.perResourceBreakdown).toHaveLength(2);
    expect(
      result.perResourceBreakdown?.find(
        (e) => e.resourceType === "AWS::EC2::Instance",
      )?.cost,
    ).toBe("~$30.00/mo");
  });

  // Axis K: costDetail=true, no perResourceCosts, single resource →
  //         fallback to single-entry breakdown from resourceType + estimatedMonthlyCost.
  it("Axis K: costDetail=true with single resource → single-entry breakdown", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 7.5,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      resourceType: "AWS::Lambda::Function",
      estimatedMonthlyCost: "~$7.50/mo",
      perResourceCosts: undefined,
    });
    const result = formatCostBlock(state, { costDetail: true });
    expect(result.perResourceBreakdown).toBeDefined();
    expect(result.perResourceBreakdown).toHaveLength(1);
    expect(result.perResourceBreakdown?.[0]?.resourceType).toBe(
      "AWS::Lambda::Function",
    );
    expect(result.perResourceBreakdown?.[0]?.cost).toBe("~$7.50/mo");
  });

  // Axis B-02 advisory F1: compound plan where estimatedMonthlyCost is "Free"
  // but pricingBreakdown.fixedSubtotal is the real accumulated total.
  it("F1 advisory: compound plan — pricingBreakdown.fixedSubtotal wins over 'Free' label", () => {
    const state = makeMinimalState({
      pricingBreakdown: {
        fixedItems: [],
        usageBasedItems: [],
        fixedSubtotal: 42.0,
        fetchedAt: new Date().toISOString(),
        hasCacheHits: false,
        hasPartialFailure: false,
      },
      estimatedMonthlyCost: "Free", // companion resource emitted "Free" last
    });
    const result = formatCostBlock(state);
    // Must use pricingBreakdown, not parse "Free" → null.
    expect(result.infraCostMonthly).toBe(42.0);
    expect(result.unavailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story 108-B-03 — Registry-driven variant axes (F2 harness compliance)
//
// Axes VM-A and VM-G iterate ALL supported types via enumerateTypes() from
// the variant-matrix harness. This prevents silent coverage gaps when new
// types are added to SUPPORTED_TYPES_ARRAY.
// ---------------------------------------------------------------------------

describe("formatCostBlock — registry-driven variant (Story 108-B-03 F2)", () => {
  function makeRegistryState(
    resourceType: string,
    overrides: Partial<AgentState> = {},
  ): AgentState {
    return {
      userIntent: `create ${resourceType}`,
      runId: "b03-vm-test-run",
      executionMode: ExecutionMode.PLAN,
      executionStatus: ExecutionStatus.PENDING,
      outputFormat: "text",
      resourceType,
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
      messages: [],
      config: new ProcessEnvConfigAdapter(),
      ...overrides,
    } as AgentState;
  }

  // Axis VM-A — priced-type variant: for every type that HAS a registered
  // pricing decomposer, formatCostBlock must return unavailable=false when
  // pricingBreakdown.fixedSubtotal is non-zero.
  it.each(enumerateTypes().filter((t) => defaultDecomposerRegistry.has(t)))(
    "Axis VM-A: priced type %s — fixedSubtotal→infraCostMonthly, unavailable=false",
    (resourceType) => {
      const state = makeRegistryState(resourceType, {
        pricingBreakdown: {
          fixedItems: [],
          usageBasedItems: [],
          fixedSubtotal: 10.0,
          fetchedAt: new Date().toISOString(),
          hasCacheHits: false,
          hasPartialFailure: false,
        },
      });
      const result = formatCostBlock(state);
      expect(result.unavailable).toBe(false);
      expect(result.infraCostMonthly).toBe(10.0);
    },
  );

  // Axis VM-G — pricing-unavailable path: for every supported type, when the
  // pricing pipeline produced neither pricingBreakdown nor estimatedMonthlyCost
  // (e.g. MCP pricing call failed at runtime), formatCostBlock must return
  // unavailable=true. This validates AC#8 for all 38 types: "Cost estimate:
  // unavailable" rather than crashing or showing $0.00.
  it.each(enumerateTypes())(
    "Axis VM-G: type %s — no pricing state → unavailable=true",
    (resourceType) => {
      const state = makeRegistryState(resourceType, {
        pricingBreakdown: undefined,
        estimatedMonthlyCost: undefined,
      });
      const result = formatCostBlock(state);
      expect(result.unavailable).toBe(true);
      expect(result.infraCostMonthly).toBeNull();
    },
  );
});
