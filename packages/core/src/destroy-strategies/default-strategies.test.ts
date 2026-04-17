/**
 * Dedicated unit tests for the flag-only default strategy lists
 * (`arnIdentifierStrategies`, `slowDeleteStrategies`) — Story 50-6.
 *
 * These two lists drive the CLI + MCP dispatcher heuristics for "must
 * pass ARN as CCAPI Identifier" and "extend polling cap for slow
 * deletes". They are pure data, so the tests pin the shape and assert
 * every entry references a valid RESOURCE_TYPES constant (not a typo
 * string) and has only flag-only metadata (no hooks).
 */
import { describe, it, expect } from "vitest";
import {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";
import { RESOURCE_TYPES } from "../config/resource-types/named.js";
import { SUPPORTED_TYPES_ARRAY } from "../config/resource-types/supported.js";
import type { DestroyStrategy } from "./types.js";

const SUPPORTED = new Set<string>(SUPPORTED_TYPES_ARRAY);
const RESOURCE_TYPE_VALUES = new Set<string>(Object.values(RESOURCE_TYPES));

const assertFlagOnly = (strategy: DestroyStrategy) => {
  // Flag-only strategies have no behavioural hooks — all behaviour is
  // expressed through the two metadata booleans. If a hook appears here
  // the entry belongs in strategies/<name>.ts instead.
  expect(strategy.extractIdentifier).toBeUndefined();
  expect(strategy.preDestroy).toBeUndefined();
  expect(strategy.destroy).toBeUndefined();
  expect(strategy.postDestroy).toBeUndefined();
};

describe("arnIdentifierStrategies", () => {
  it("every entry references a valid RESOURCE_TYPES constant", () => {
    for (const strategy of arnIdentifierStrategies) {
      expect(RESOURCE_TYPE_VALUES.has(strategy.resourceType)).toBe(true);
      expect(SUPPORTED.has(strategy.resourceType)).toBe(true);
    }
  });

  it("every entry sets usesArnIdentifier: true (that is the whole point)", () => {
    for (const strategy of arnIdentifierStrategies) {
      expect(strategy.usesArnIdentifier).toBe(true);
    }
  });

  it("every entry is flag-only (no behaviour hooks)", () => {
    for (const strategy of arnIdentifierStrategies) {
      assertFlagOnly(strategy);
    }
  });

  it("contains SNS_TOPIC, SECRETSMANAGER_SECRET, ECS_CLUSTER, EVENTS_RULE, SNS_SUBSCRIPTION, ELBV2 LB", () => {
    const types = arnIdentifierStrategies.map((s) => s.resourceType);
    expect(types).toEqual(
      expect.arrayContaining([
        RESOURCE_TYPES.SNS_TOPIC,
        RESOURCE_TYPES.SNS_SUBSCRIPTION,
        RESOURCE_TYPES.SECRETSMANAGER_SECRET,
        RESOURCE_TYPES.ECS_CLUSTER,
        RESOURCE_TYPES.EVENTS_RULE,
        RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      ]),
    );
  });

  it("ELBV2_LOAD_BALANCER is marked slow (ENI drain window)", () => {
    const alb = arnIdentifierStrategies.find(
      (s) => s.resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(alb).toBeDefined();
    expect(alb?.isSlow).toBe(true);
  });

  it("has no duplicate resource types", () => {
    const types = arnIdentifierStrategies.map((s) => s.resourceType);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("slowDeleteStrategies", () => {
  it("every entry references a valid RESOURCE_TYPES constant", () => {
    for (const strategy of slowDeleteStrategies) {
      expect(RESOURCE_TYPE_VALUES.has(strategy.resourceType)).toBe(true);
      expect(SUPPORTED.has(strategy.resourceType)).toBe(true);
    }
  });

  it("every entry sets isSlow: true", () => {
    for (const strategy of slowDeleteStrategies) {
      expect(strategy.isSlow).toBe(true);
    }
  });

  it("every entry is flag-only (no behaviour hooks)", () => {
    for (const strategy of slowDeleteStrategies) {
      assertFlagOnly(strategy);
    }
  });

  it("covers RDS_DB_INSTANCE and EC2_NAT_GATEWAY (the two slow classes we provision)", () => {
    const types = slowDeleteStrategies.map((s) => s.resourceType);
    expect(types).toEqual(
      expect.arrayContaining([
        RESOURCE_TYPES.RDS_DB_INSTANCE,
        RESOURCE_TYPES.EC2_NAT_GATEWAY,
      ]),
    );
  });

  it("has no duplicate resource types", () => {
    const types = slowDeleteStrategies.map((s) => s.resourceType);
    expect(new Set(types).size).toBe(types.length);
  });
});
