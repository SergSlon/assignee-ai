/**
 * Integration test — verifies all pricing decomposers work correctly
 * through the defaultDecomposerRegistry pipeline.
 *
 * Unlike the unit tests (per-decomposer), this test exercises the full
 * registry -> decompose() -> line item validation path for every
 * SUPPORTED_TYPES_ARRAY entry, ensuring structural correctness and
 * variant consistency.
 *
 * @see Epic 39
 */

import { describe, it, expect } from "vitest";
import {
  SUPPORTED_TYPES_ARRAY,
  RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { defaultDecomposerRegistry } from "../index.js";
import type { PricingLineItem } from "../decomposer-types.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** The free resource types — decompose returns [] (no billable line items) */
const FREE_TYPES: readonly string[] = [
  RESOURCE_TYPES.EC2_VPC,
  RESOURCE_TYPES.EC2_SUBNET,
  RESOURCE_TYPES.EC2_SECURITY_GROUP,
  RESOURCE_TYPES.IAM_ROLE,
  RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  RESOURCE_TYPES.EC2_ROUTE_TABLE,
  RESOURCE_TYPES.EC2_ROUTE,
  RESOURCE_TYPES.ECS_CLUSTER,
  // WV4-A: VPC compound cross-references — pure CFN linkage, no cost
  RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
  // A1 follow-up: EFS::MountTarget is free — the billable cost lives
  // on the parent EFS::FileSystem storage + NFS data transfer.
  RESOURCE_TYPES.EFS_MOUNT_TARGET,
  // A8 (2026-04-08): EventBridge Rule is free on the default bus —
  // rule evaluation and target delivery bill $0; custom-bus publishing
  // is a bus-level charge, not a rule-level one, and the per-month
  // cost is workload-dependent, so the decomposer returns [].
  RESOURCE_TYPES.EVENTS_RULE,
  // A9 (2026-04-09): EventBridge custom EventBus bills $1/M events
  // PUBLISHED to the bus. Per-event rate is fixed but publish volume
  // is workload-dependent, so the decomposer returns [].
  RESOURCE_TYPES.EVENTS_EVENT_BUS,
  // SSM Standard tier is also free, but the decomposer is registered for
  // Advanced tier too — it is NOT in the "always free" list.
] as const;

/** The 14 paid resource types (all others) */
const PAID_TYPES = SUPPORTED_TYPES_ARRAY.filter((t) => !FREE_TYPES.includes(t));

// ── Helpers ──────────────────────────────────────────────────────────────────

function assertValidLineItem(item: PricingLineItem): void {
  expect(item.label).toBeTruthy();
  expect(typeof item.label).toBe("string");
  expect(item.serviceCode).toBeTruthy();
  expect(typeof item.serviceCode).toBe("string");
  expect(Array.isArray(item.filters)).toBe(true);
  expect(item.filters.length).toBeGreaterThan(0);
  expect(["fixed", "usage_based"]).toContain(item.kind);
  expect(item.unit).toBeTruthy();
  expect(item.priceUnit).toBeTruthy();

  // Every filter must have Field, Value, Type="TERM_MATCH"
  for (const filter of item.filters) {
    expect(filter.Field).toBeTruthy();
    expect(typeof filter.Field).toBe("string");
    expect(filter.Value).toBeTruthy();
    expect(typeof filter.Value).toBe("string");
    expect(filter.Type).toBe("TERM_MATCH");
  }
}

// ── 1. Registry completeness ─────────────────────────────────────────────────

describe("registry completeness", () => {
  it("every SUPPORTED_TYPES_ARRAY entry has a registered decomposer", () => {
    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      expect(
        defaultDecomposerRegistry.has(resourceType),
        `missing decomposer for ${resourceType}`,
      ).toBe(true);
    }
  });

  it("decompose() returns an array for every registered type", () => {
    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      const items = defaultDecomposerRegistry.decompose(resourceType, {});
      expect(
        Array.isArray(items),
        `${resourceType} decompose did not return array`,
      ).toBe(true);
    }
  });
});

// ── 2. Decompose + line item structure ───────────────────────────────────────

describe("decompose + line item structure — paid types", () => {
  for (const resourceType of PAID_TYPES) {
    // SSM Standard returns [] (free), so we test with Advanced tier
    const desiredState: Record<string, unknown> =
      resourceType === RESOURCE_TYPES.SSM_PARAMETER ? { Tier: "Advanced" } : {};

    it(`${resourceType} returns non-empty array with valid line items`, () => {
      const items = defaultDecomposerRegistry.decompose(
        resourceType,
        desiredState,
      );
      expect(items.length).toBeGreaterThan(0);

      for (const item of items) {
        assertValidLineItem(item);
      }
    });
  }
});

// ── 3. Variant consistency ───────────────────────────────────────────────────

describe("variant consistency", () => {
  describe("DynamoDB — PAY_PER_REQUEST vs PROVISIONED", () => {
    it("PAY_PER_REQUEST returns 3 items (read, write, storage)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.DYNAMODB_TABLE,
        { BillingMode: "PAY_PER_REQUEST" },
      );
      expect(items).toHaveLength(3);
      // On-demand: read + write are usage_based, storage is usage_based
      const usageBased = items.filter((i) => i.kind === "usage_based");
      expect(usageBased).toHaveLength(3);
    });

    it("PROVISIONED returns 3 items (read, write, storage)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.DYNAMODB_TABLE,
        {
          BillingMode: "PROVISIONED",
          ProvisionedThroughput: {
            ReadCapacityUnits: 10,
            WriteCapacityUnits: 5,
          },
        },
      );
      expect(items).toHaveLength(3);
      // Provisioned: read + write are fixed, storage is usage_based
      const fixed = items.filter((i) => i.kind === "fixed");
      const usageBased = items.filter((i) => i.kind === "usage_based");
      expect(fixed).toHaveLength(2);
      expect(usageBased).toHaveLength(1);
    });

    it("PAY_PER_REQUEST and PROVISIONED have different kind distributions", () => {
      const onDemand = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.DYNAMODB_TABLE,
        { BillingMode: "PAY_PER_REQUEST" },
      );
      const provisioned = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.DYNAMODB_TABLE,
        { BillingMode: "PROVISIONED" },
      );
      const onDemandKinds = onDemand.map((i) => i.kind).sort();
      const provisionedKinds = provisioned.map((i) => i.kind).sort();
      expect(onDemandKinds).not.toEqual(provisionedKinds);
    });
  });

  describe("ELBv2 — application vs network", () => {
    it("application returns ALB items", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        { Type: "application" },
      );
      expect(items).toHaveLength(2);
      const filterValues = items.flatMap((i) => i.filters.map((f) => f.Value));
      expect(filterValues).toContain("Load Balancer-Application");
      expect(filterValues).not.toContain("Load Balancer-Network");
    });

    it("network returns NLB items", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        { Type: "network" },
      );
      expect(items).toHaveLength(2);
      const filterValues = items.flatMap((i) => i.filters.map((f) => f.Value));
      expect(filterValues).toContain("Load Balancer-Network");
      expect(filterValues).not.toContain("Load Balancer-Application");
    });
  });

  describe("SQS — Standard vs FIFO", () => {
    it("Standard queue has productFamily=Queue", () => {
      // Tier C: dropped redundant toBeDefined() — use find!() at the find
      // site so the subsequent .Value access is unconditional
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.SQS_QUEUE,
        {},
      );
      expect(items).toHaveLength(1);
      const productFamily = items[0]!.filters.find(
        (f) => f.Field === "productFamily",
      )!;
      expect(productFamily.Value).toBe("Queue");
    });

    it("FIFO queue has productFamily=FIFO Queue", () => {
      // Tier C: same pattern
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.SQS_QUEUE,
        { FifoQueue: true },
      );
      expect(items).toHaveLength(1);
      const productFamily = items[0]!.filters.find(
        (f) => f.Field === "productFamily",
      )!;
      expect(productFamily.Value).toBe("FIFO Queue");
    });
  });

  describe("CloudWatch Alarm — standard vs high resolution", () => {
    it("Period=10 returns High Resolution", () => {
      // Tier C: same pattern
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.CLOUDWATCH_ALARM,
        { Period: 10 },
      );
      expect(items).toHaveLength(1);
      const alarmType = items[0]!.filters.find((f) => f.Field === "alarmType")!;
      expect(alarmType.Value).toBe("High Resolution");
    });

    it("Period=300 returns Standard", () => {
      // Tier C: same pattern
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.CLOUDWATCH_ALARM,
        { Period: 300 },
      );
      expect(items).toHaveLength(1);
      const alarmType = items[0]!.filters.find((f) => f.Field === "alarmType")!;
      expect(alarmType.Value).toBe("Standard");
    });
  });

  describe("Logs — STANDARD vs INFREQUENT_ACCESS", () => {
    it("STANDARD has standard usagetype values", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        { LogGroupClass: "STANDARD" },
      );
      expect(items).toHaveLength(2);
      const usagetypes = items.flatMap((i) =>
        i.filters.filter((f) => f.Field === "usagetype").map((f) => f.Value),
      );
      expect(usagetypes).toContain("CW:DataProcessing-Bytes");
      expect(usagetypes).toContain("CW:DataStorage-Bytes");
    });

    it("INFREQUENT_ACCESS has infrequent access usagetype values", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.LOGS_LOG_GROUP,
        { LogGroupClass: "INFREQUENT_ACCESS" },
      );
      expect(items).toHaveLength(2);
      const usagetypes = items.flatMap((i) =>
        i.filters.filter((f) => f.Field === "usagetype").map((f) => f.Value),
      );
      expect(usagetypes).toContain(
        "CW:LogInfrequentAccess-DataProcessing-Bytes",
      );
      expect(usagetypes).toContain("CW:LogInfrequentAccess-DataStorage-Bytes");
    });
  });

  describe("SSM — Standard vs Advanced", () => {
    it("Standard returns empty array (free)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.SSM_PARAMETER,
        { Tier: "Standard" },
      );
      expect(items).toHaveLength(0);
    });

    it("Advanced returns 2 items (storage + API calls)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.SSM_PARAMETER,
        { Tier: "Advanced" },
      );
      expect(items).toHaveLength(2);
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Parameter storage");
      expect(labels).toContain("API calls");
    });
  });

  describe("API Gateway — HTTP vs WEBSOCKET", () => {
    it("HTTP returns 2 items (requests + data transfer)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.APIGATEWAYV2_API,
        { ProtocolType: "HTTP" },
      );
      expect(items).toHaveLength(2);
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Requests");
      expect(labels).toContain("Data transfer out");
    });

    it("WEBSOCKET returns 2 items (messages + connection minutes)", () => {
      const items = defaultDecomposerRegistry.decompose(
        RESOURCE_TYPES.APIGATEWAYV2_API,
        { ProtocolType: "WEBSOCKET" },
      );
      expect(items).toHaveLength(2);
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Messages");
      expect(labels).toContain("Connection minutes");
    });
  });
});

// ── 4. Free resource consistency ─────────────────────────────────────────────

describe("free resource consistency — always return empty array", () => {
  for (const resourceType of FREE_TYPES) {
    it(`${resourceType} returns [] for empty desiredState`, () => {
      const items = defaultDecomposerRegistry.decompose(resourceType, {});
      expect(items).toHaveLength(0);
    });

    it(`${resourceType} returns [] for realistic AWS desiredState`, () => {
      const items = defaultDecomposerRegistry.decompose(resourceType, {
        BucketName: "my-app-prod-data",
        VersioningConfiguration: { Status: "Enabled" },
        Tags: [{ Key: "Environment", Value: "production" }],
      });
      expect(items).toHaveLength(0);
    });
  }
});
