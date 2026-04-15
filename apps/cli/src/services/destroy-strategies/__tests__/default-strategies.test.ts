/**
 * Tests for the flag-only strategy tables (arnIdentifierStrategies,
 * slowDeleteStrategies) and the createDestroyRegistry() factory.
 *
 * Locks in the EXACT set of CCAPI resource types previously encoded
 * in destroy-service.ts's `ARN_IDENTIFIED_TYPES` set — regression
 * insurance for Wave-6 F1a.
 *
 * @see Wave-6 F1a
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";

import {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "../default-strategies.js";
import { createDestroyRegistry, destroyRegistry } from "../index.js";

describe("arnIdentifierStrategies", () => {
  it("contains exactly the flag-only ARN-identified CCAPI types (ELBv2 promoted to dedicated strategy in F1b)", () => {
    const types = arnIdentifierStrategies.map((s) => s.resourceType).sort();
    expect(types).toEqual(
      [
        RESOURCE_TYPES.SNS_TOPIC,
        RESOURCE_TYPES.SNS_SUBSCRIPTION,
        RESOURCE_TYPES.SECRETSMANAGER_SECRET,
        RESOURCE_TYPES.ECS_CLUSTER,
        RESOURCE_TYPES.EVENTS_RULE,
      ].sort(),
    );
  });

  it("sets usesArnIdentifier=true on every entry (otherwise the flag is inert)", () => {
    for (const s of arnIdentifierStrategies) {
      expect(s.usesArnIdentifier).toBe(true);
    }
  });

  it("registry still exposes ELBv2 LoadBalancer as both ARN-identified AND slow (via its dedicated strategy file)", () => {
    const registry = createDestroyRegistry();
    const lb = registry.get(RESOURCE_TYPES.ELBV2_LOAD_BALANCER);
    expect(lb).toBeDefined();
    expect(lb?.usesArnIdentifier).toBe(true);
    expect(lb?.isSlow).toBe(true);
    // ELBv2 also ships a postDestroy ENI-drain hook in F1b.
    expect(typeof lb?.postDestroy).toBe("function");
  });
});

describe("slowDeleteStrategies", () => {
  it("covers the CLI slow-delete types that don't also need ARN identifiers", () => {
    const types = slowDeleteStrategies.map((s) => s.resourceType).sort();
    expect(types).toEqual(
      [RESOURCE_TYPES.RDS_DB_INSTANCE, RESOURCE_TYPES.EC2_NAT_GATEWAY].sort(),
    );
  });

  it("sets isSlow=true and leaves usesArnIdentifier unset", () => {
    for (const s of slowDeleteStrategies) {
      expect(s.isSlow).toBe(true);
      expect(s.usesArnIdentifier).toBeUndefined();
    }
  });
});

describe("createDestroyRegistry()", () => {
  it("returns a registry populated with every flag-only strategy", () => {
    const registry = createDestroyRegistry();
    for (const s of [...arnIdentifierStrategies, ...slowDeleteStrategies]) {
      expect(registry.has(s.resourceType)).toBe(true);
    }
  });

  it("produces a fresh registry each call (no shared state)", () => {
    const a = createDestroyRegistry();
    const b = createDestroyRegistry();
    expect(a).not.toBe(b);
    // Mutating one must not affect the other.
    a.register({
      resourceType: "AWS::Fake::Canary",
      usesArnIdentifier: true,
    });
    expect(a.has("AWS::Fake::Canary")).toBe(true);
    expect(b.has("AWS::Fake::Canary")).toBe(false);
  });

  it("the exported singleton has the same coverage as a fresh factory call", () => {
    const fresh = createDestroyRegistry();
    for (const t of fresh.registeredTypes()) {
      expect(destroyRegistry.has(t)).toBe(true);
    }
  });

  it("F1b registers all eight complex strategies (S3, CloudFront, DDB, IGW, RouteTable, EFS, EIP, ELBv2)", () => {
    const registry = createDestroyRegistry();
    expect(registry.has(RESOURCE_TYPES.S3_BUCKET)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.DYNAMODB_TABLE)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.EC2_INTERNET_GATEWAY)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.EC2_ROUTE_TABLE)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.EFS_FILE_SYSTEM)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.ELBV2_LOAD_BALANCER)).toBe(true);
  });
});
