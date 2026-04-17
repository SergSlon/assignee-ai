/**
 * Dedicated unit tests for `DestroyStrategyRegistry` (Story 50-6).
 *
 * Previously exercised only through integration tests on the CLI and
 * MCP dispatcher paths. This suite pins the contract directly:
 *
 *   - register / registerAll add and overwrite by resourceType
 *   - get / has return the registered entry / undefined / false
 *   - registeredTypes enumerates the current set
 *   - empty registry is safe for every getter
 *   - duplicate registration: last-write-wins (documented behaviour —
 *     dispatcher relies on it so CLI can override an MCP-default entry)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RESOURCE_TYPES } from "../config/resource-types/named.js";
import { DestroyStrategyRegistry } from "./registry.js";
import type { DestroyStrategy } from "./types.js";

const strategyOf = (
  overrides: Partial<DestroyStrategy> & Pick<DestroyStrategy, "resourceType">,
): DestroyStrategy => ({ ...overrides });

describe("DestroyStrategyRegistry — empty state", () => {
  let registry: DestroyStrategyRegistry;

  beforeEach(() => {
    registry = new DestroyStrategyRegistry();
  });

  it("get returns undefined for unregistered resource types", () => {
    expect(registry.get(RESOURCE_TYPES.S3_BUCKET)).toBeUndefined();
  });

  it("has returns false for unregistered resource types", () => {
    expect(registry.has(RESOURCE_TYPES.S3_BUCKET)).toBe(false);
  });

  it("registeredTypes returns an empty array", () => {
    expect(registry.registeredTypes()).toEqual([]);
  });

  it("get('') returns undefined (empty key is not registered)", () => {
    expect(registry.get("")).toBeUndefined();
    expect(registry.has("")).toBe(false);
  });
});

describe("DestroyStrategyRegistry — register", () => {
  let registry: DestroyStrategyRegistry;

  beforeEach(() => {
    registry = new DestroyStrategyRegistry();
  });

  it("register stores a single strategy", () => {
    const strategy = strategyOf({
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      usesArnIdentifier: false,
    });
    registry.register(strategy);
    expect(registry.get(RESOURCE_TYPES.S3_BUCKET)).toBe(strategy);
    expect(registry.has(RESOURCE_TYPES.S3_BUCKET)).toBe(true);
  });

  it("register overwrites an existing strategy (last-write-wins)", () => {
    const first = strategyOf({
      resourceType: RESOURCE_TYPES.SNS_TOPIC,
      usesArnIdentifier: true,
    });
    const second = strategyOf({
      resourceType: RESOURCE_TYPES.SNS_TOPIC,
      usesArnIdentifier: true,
      isSlow: true,
    });
    registry.register(first);
    registry.register(second);
    // Dispatcher contract: CLI adds refinements after MCP defaults and
    // must win — assert the second registration replaced the first.
    expect(registry.get(RESOURCE_TYPES.SNS_TOPIC)).toBe(second);
    expect(registry.get(RESOURCE_TYPES.SNS_TOPIC)?.isSlow).toBe(true);
    // Only one entry, not two, for the same resourceType.
    expect(registry.registeredTypes()).toEqual([RESOURCE_TYPES.SNS_TOPIC]);
  });
});

describe("DestroyStrategyRegistry — registerAll", () => {
  let registry: DestroyStrategyRegistry;

  beforeEach(() => {
    registry = new DestroyStrategyRegistry();
  });

  it("registerAll accepts an empty list without error", () => {
    registry.registerAll([]);
    expect(registry.registeredTypes()).toEqual([]);
  });

  it("registerAll registers every strategy in the list", () => {
    const strategies: DestroyStrategy[] = [
      strategyOf({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      strategyOf({
        resourceType: RESOURCE_TYPES.SNS_TOPIC,
        usesArnIdentifier: true,
      }),
      strategyOf({
        resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
        isSlow: true,
      }),
    ];
    registry.registerAll(strategies);

    expect(registry.has(RESOURCE_TYPES.S3_BUCKET)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.SNS_TOPIC)).toBe(true);
    expect(registry.has(RESOURCE_TYPES.EC2_NAT_GATEWAY)).toBe(true);
    expect(registry.registeredTypes()).toHaveLength(3);
    expect(registry.get(RESOURCE_TYPES.SNS_TOPIC)?.usesArnIdentifier).toBe(
      true,
    );
    expect(registry.get(RESOURCE_TYPES.EC2_NAT_GATEWAY)?.isSlow).toBe(true);
  });

  it("registerAll with duplicate resourceType entries keeps the LAST one", () => {
    const first = strategyOf({
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      usesArnIdentifier: true,
    });
    const second = strategyOf({
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      usesArnIdentifier: true,
      isSlow: true,
    });
    registry.registerAll([first, second]);
    expect(registry.get(RESOURCE_TYPES.ELBV2_LOAD_BALANCER)).toBe(second);
    expect(registry.registeredTypes()).toEqual([
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    ]);
  });
});

describe("DestroyStrategyRegistry — enumeration order", () => {
  it("registeredTypes preserves insertion order", () => {
    const registry = new DestroyStrategyRegistry();
    registry.registerAll([
      strategyOf({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      strategyOf({ resourceType: RESOURCE_TYPES.SQS_QUEUE }),
      strategyOf({ resourceType: RESOURCE_TYPES.DYNAMODB_TABLE }),
    ]);
    expect(registry.registeredTypes()).toEqual([
      RESOURCE_TYPES.S3_BUCKET,
      RESOURCE_TYPES.SQS_QUEUE,
      RESOURCE_TYPES.DYNAMODB_TABLE,
    ]);
  });

  it("overwriting preserves original insertion slot, not a new one", () => {
    // Map<string, V>.set() on an existing key keeps the original order
    // slot. Pinning this matters for audits (registeredTypes() output
    // order must be stable across invocations of the same composition).
    const registry = new DestroyStrategyRegistry();
    registry.register(
      strategyOf({ resourceType: RESOURCE_TYPES.S3_BUCKET, isSlow: false }),
    );
    registry.register(strategyOf({ resourceType: RESOURCE_TYPES.SQS_QUEUE }));
    registry.register(
      strategyOf({ resourceType: RESOURCE_TYPES.S3_BUCKET, isSlow: true }),
    );
    expect(registry.registeredTypes()).toEqual([
      RESOURCE_TYPES.S3_BUCKET,
      RESOURCE_TYPES.SQS_QUEUE,
    ]);
    expect(registry.get(RESOURCE_TYPES.S3_BUCKET)?.isSlow).toBe(true);
  });
});
