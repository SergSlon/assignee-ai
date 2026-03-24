/**
 * Integration test verifying all Tier 2 resource types are fully registered
 * across SUPPORTED_TYPES_ARRAY, plugin registry, pricing registry, and IAM actions.
 *
 * @see Story 26.6 — Registry Updates + SUPPORTED_TYPES_ARRAY Expansion
 */
import { describe, it, expect } from "vitest";
import {
  SUPPORTED_TYPES_ARRAY,
  RESOURCE_TYPES,
  defaultPluginRegistry,
  defaultPricingRegistry,
} from "../index.js";
import { getRequiredIamActions } from "./iam-actions.js";
import { defaultPatternRegistry } from "../pattern-templates/index.js";

const TIER_2_TYPES = [
  RESOURCE_TYPES.APIGATEWAYV2_API,
  RESOURCE_TYPES.CLOUDWATCH_ALARM,
  RESOURCE_TYPES.SECRETSMANAGER_SECRET,
] as const;

describe("Tier 2 resource types in SUPPORTED_TYPES_ARRAY", () => {
  it.each(TIER_2_TYPES)("%s is in SUPPORTED_TYPES_ARRAY", (type) => {
    expect(SUPPORTED_TYPES_ARRAY).toContain(type);
  });
});

describe("Tier 2 plugin registrations", () => {
  it.each(TIER_2_TYPES)("%s has a registered plugin", (type) => {
    const plugin = defaultPluginRegistry.get(type);
    expect(plugin).toBeDefined();
    expect(plugin?.resourceType).toBe(type);
  });
});

describe("Tier 2 pricing strategy registrations", () => {
  it.each(TIER_2_TYPES)(
    "%s has a registered pricing strategy (returns MCP config, not fallback)",
    (type) => {
      // If strategy is registered, getMcpConfig returns non-null config.
      // The fallback unknownPricingStrategy has no mcpConfig method, returning null.
      const mcpConfig = defaultPricingRegistry.getMcpConfig(type, {});
      expect(mcpConfig).not.toBeNull();
    },
  );
});

describe("Tier 2 IAM action registrations", () => {
  it("AWS::ApiGatewayV2::Api has complete service-specific IAM actions", () => {
    const actions = getRequiredIamActions("AWS::ApiGatewayV2::Api");
    const serviceActions = actions.filter((a) => a.startsWith("apigateway:"));
    expect(serviceActions.length).toBeGreaterThanOrEqual(7);
    expect(serviceActions).toContain("apigateway:CreateApi");
    expect(serviceActions).toContain("apigateway:DeleteApi");
    expect(serviceActions).toContain("apigateway:GetApi");
    expect(serviceActions).toContain("apigateway:UpdateApi");
    expect(serviceActions).toContain("apigateway:CreateRoute");
    expect(serviceActions).toContain("apigateway:CreateIntegration");
    expect(serviceActions).toContain("apigateway:CreateStage");
    expect(serviceActions).toContain("apigateway:CreateDeployment");
    expect(serviceActions).toContain("apigateway:TagResource");
  });

  it("AWS::CloudWatch::Alarm has complete service-specific IAM actions", () => {
    const actions = getRequiredIamActions("AWS::CloudWatch::Alarm");
    const serviceActions = actions.filter((a) => a.startsWith("cloudwatch:"));
    expect(serviceActions.length).toBeGreaterThanOrEqual(4);
    expect(serviceActions).toContain("cloudwatch:PutMetricAlarm");
    expect(serviceActions).toContain("cloudwatch:DeleteAlarms");
    expect(serviceActions).toContain("cloudwatch:DescribeAlarms");
    expect(serviceActions).toContain("cloudwatch:TagResource");
    expect(serviceActions).toContain("cloudwatch:EnableAlarmActions");
    expect(serviceActions).toContain("cloudwatch:DisableAlarmActions");
  });

  it("AWS::SecretsManager::Secret has complete service-specific IAM actions", () => {
    const actions = getRequiredIamActions("AWS::SecretsManager::Secret");
    const serviceActions = actions.filter((a) =>
      a.startsWith("secretsmanager:"),
    );
    expect(serviceActions.length).toBeGreaterThanOrEqual(5);
    expect(serviceActions).toContain("secretsmanager:CreateSecret");
    expect(serviceActions).toContain("secretsmanager:DeleteSecret");
    expect(serviceActions).toContain("secretsmanager:DescribeSecret");
    expect(serviceActions).toContain("secretsmanager:UpdateSecret");
    expect(serviceActions).toContain("secretsmanager:TagResource");
    expect(serviceActions).toContain("secretsmanager:PutSecretValue");
    expect(serviceActions).toContain("secretsmanager:GetSecretValue");
  });
});

describe("Serverless API compound pattern integration", () => {
  it("serverless-api pattern is registered in default registry", () => {
    expect(defaultPatternRegistry.has("serverless-api")).toBe(true);
  });

  it("detects 'create a serverless API' intent", () => {
    const pattern = defaultPatternRegistry.detect("create a serverless API");
    expect(pattern).toBeDefined();
    expect(pattern?.patternId).toBe("serverless-api");
  });

  it("produces 8 resources", () => {
    const pattern = defaultPatternRegistry.get("serverless-api");
    expect(pattern?.resourceList).toHaveLength(8);
  });
});
