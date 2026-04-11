/**
 * Story 46.2 — DataSource attribution coverage.
 *
 * Parametrized over the entire pricing strategy registry: every registered
 * resource type's `estimateLocal()` MUST return a `source` value, and that
 * value MUST be one of the 5 documented variants. This test catches the
 * gap that motivated the story — strategies that silently produced
 * unattributed price labels which the display layer couldn't tell apart
 * from live MCP data.
 *
 * Walks the live registry via `defaultPricingRegistry.registeredTypes()`
 * (added for this story) so adding a new strategy to `pricing/index.ts`
 * automatically enrolls it in this matrix — no fixture sync needed.
 * Closes Blind Hunter F1 from the wave-2 review pass.
 *
 * Also exercises:
 *   - Free-tier strategies tag `"free"` (not `"fallback"`), so the display
 *     layer doesn't slap "(estimated)" on a known-free resource
 *   - `formatLabelWithSource` renders the right suffix for each variant
 *   - Conditional-branch strategies (ssm Standard vs Advanced, eventsRule
 *     default-bus vs custom-bus, apigatewayv2 HTTP vs WebSocket) get
 *     coverage on BOTH branches, not just the empty-desiredState path
 */

import { describe, it, expect } from "vitest";
import { defaultPricingRegistry } from "./index.js";
import { formatLabelWithSource, type DataSource } from "./types.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";

const ALL_SOURCES: readonly DataSource[] = [
  "mcp",
  "cached",
  "fallback",
  "offline",
  "free",
];

/**
 * Walks the live registry instead of a hand-maintained snapshot. Adding a
 * new strategy in `pricing/index.ts` automatically enrolls it here — no
 * fixture sync needed. Sorted for stable test output ordering.
 */
const REGISTERED_TYPES: readonly string[] = Object.freeze(
  [...defaultPricingRegistry.registeredTypes()].sort(),
);

describe("PricingEstimate.source — registry coverage (Story 46.2)", () => {
  it("registry has 30+ strategies and every type starts with AWS::", () => {
    expect(REGISTERED_TYPES.length).toBeGreaterThanOrEqual(30);
    for (const cfnType of REGISTERED_TYPES) {
      expect(
        cfnType.startsWith("AWS::"),
        `non-AWS resource type leaked into the registry: ${cfnType}`,
      ).toBe(true);
    }
  });

  it("registered types are a superset of the documented core types", () => {
    // Defensive: confirm that the parametrized iteration actually
    // exercises the high-impact resource types we know users hit. Catches
    // a future commit that breaks the registry init order.
    const corePresence = [
      RESOURCE_TYPES.S3_BUCKET,
      RESOURCE_TYPES.EC2_INSTANCE,
      RESOURCE_TYPES.RDS_DB_INSTANCE,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
      RESOURCE_TYPES.IAM_ROLE,
    ];
    for (const t of corePresence) {
      expect(REGISTERED_TYPES).toContain(t);
    }
  });

  it.each(REGISTERED_TYPES)(
    "%s estimateLocal() returns a valid DataSource",
    (resourceType) => {
      const estimate = defaultPricingRegistry.estimate(resourceType, {});
      expect(estimate.source).toBeDefined();
      expect(ALL_SOURCES).toContain(estimate.source);
    },
  );

  it.each(REGISTERED_TYPES)(
    "%s tags isFree:true ↔ source:'free' consistently",
    (resourceType) => {
      const estimate = defaultPricingRegistry.estimate(resourceType, {});
      // The two flags must agree: a free-tier resource MUST tag source
      // "free" (so display drops the suffix), and a non-free resource
      // MUST NOT tag source "free". Catches the wave-1 SSM/ECS/etc.
      // bugs where isFree flipped without source updating.
      if (estimate.isFree === true) {
        expect(estimate.source).toBe("free");
      } else {
        expect(estimate.source).not.toBe("free");
      }
    },
  );
});

// ── Conditional-branch coverage (Edge F6 / Blind 9) ────────────────────────
// The matrix above only exercises `estimateLocal(type, {})`. Several
// strategies have desiredState-driven branches whose source values weren't
// covered by the empty-state pass. Tag each branch explicitly here so a
// regression in either path fails loudly.

describe("PricingEstimate.source — conditional-branch coverage", () => {
  it('SSM Standard tier → source="free"', () => {
    const result = defaultPricingRegistry.estimate(
      RESOURCE_TYPES.SSM_PARAMETER,
      { Tier: "Standard" },
    );
    expect(result.source).toBe("free");
    expect(result.isFree).toBe(true);
  });

  it('SSM Advanced tier → source="fallback" (decomposer handles billable rates)', () => {
    const result = defaultPricingRegistry.estimate(
      RESOURCE_TYPES.SSM_PARAMETER,
      { Tier: "Advanced" },
    );
    expect(result.source).toBe("fallback");
    expect(result.isFree).not.toBe(true);
  });

  it('SSM Intelligent-Tiering (non-standard) → source="fallback"', () => {
    const result = defaultPricingRegistry.estimate(
      RESOURCE_TYPES.SSM_PARAMETER,
      { Tier: "Intelligent-Tiering" },
    );
    expect(result.source).toBe("fallback");
  });

  it('EventBridge Rule on default bus → source="free"', () => {
    const result = defaultPricingRegistry.estimate(RESOURCE_TYPES.EVENTS_RULE, {
      EventBusName: "default",
    });
    expect(result.source).toBe("free");
    expect(result.isFree).toBe(true);
  });

  it('EventBridge Rule on custom event bus → source="fallback"', () => {
    const result = defaultPricingRegistry.estimate(RESOURCE_TYPES.EVENTS_RULE, {
      EventBusName: "my-custom-bus",
    });
    expect(result.source).toBe("fallback");
    expect(result.isFree).not.toBe(true);
  });

  it('ApiGatewayV2 HTTP API → source="fallback"', () => {
    const result = defaultPricingRegistry.estimate(
      RESOURCE_TYPES.APIGATEWAYV2_API,
      { ProtocolType: "HTTP" },
    );
    expect(result.source).toBe("fallback");
    expect(result.label).toContain("HTTP");
  });

  it('ApiGatewayV2 WebSocket API → source="fallback"', () => {
    const result = defaultPricingRegistry.estimate(
      RESOURCE_TYPES.APIGATEWAYV2_API,
      { ProtocolType: "WEBSOCKET" },
    );
    expect(result.source).toBe("fallback");
    expect(result.label).toContain("WebSocket");
  });
});

describe("formatLabelWithSource — display rules", () => {
  it.each([
    ["mcp", "$32.85/mo", "$32.85/mo (live)"],
    ["cached", "$32.85/mo", "$32.85/mo (cached)"],
    ["fallback", "~$32/mo", "~$32/mo (estimated)"],
    ["offline", "$10.00/month", "$10.00/month (from log)"],
    ["free", "Free", "Free"],
  ] as Array<[DataSource, string, string]>)(
    "%s source → %s",
    (source, label, expected) => {
      expect(formatLabelWithSource(label, source)).toBe(expected);
    },
  );

  it("free source produces no suffix even on a non-Free label", () => {
    // Belt-and-braces: the suffix is empty regardless of the input
    // string when source==="free".
    expect(formatLabelWithSource("anything-here", "free")).toBe(
      "anything-here",
    );
  });

  it("every DataSource value is handled (no missing branch)", () => {
    // Catches a regression where a new DataSource variant is added to
    // the type union but the SOURCE_SUFFIX record forgets to define a
    // suffix for it. TypeScript catches this at compile time but a
    // runtime smoke is cheap insurance.
    for (const source of ALL_SOURCES) {
      const out = formatLabelWithSource("X", source);
      expect(typeof out).toBe("string");
      expect(out.startsWith("X")).toBe(true);
    }
  });
});
