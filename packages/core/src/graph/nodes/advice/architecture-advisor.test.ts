import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "../../../index.js";
import type { ArchitecturePattern, ResourceSpec } from "../../../index.js";
import { architectureAdvisor } from "./architecture-advisor.js";

function makePattern(
  patternId: string,
  resources: Array<{ resourceId: string; resourceType: string }>,
): { pattern: ArchitecturePattern; queue: ResourceSpec[] } {
  return {
    pattern: {
      patternId,
      displayName: patternId,
      resources: resources.map((r) => ({
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        displayName: r.resourceId,
      })),
      defaultOptions: {},
    } as unknown as ArchitecturePattern,
    queue: resources.map((r) => ({
      resourceId: r.resourceId,
      resourceType: r.resourceType,
    })) as ResourceSpec[],
  };
}

describe("architectureAdvisor", () => {
  it("returns empty for standalone resources (no pattern)", () => {
    const hints = architectureAdvisor(undefined, undefined);
    expect(hints).toHaveLength(0);
  });

  it("suggests NAT Gateway for vpc-networking without one", () => {
    const { pattern, queue } = makePattern("vpc-networking", [
      { resourceId: "vpc", resourceType: RESOURCE_TYPES.EC2_VPC },
      { resourceId: "subnet", resourceType: RESOURCE_TYPES.EC2_SUBNET },
      { resourceId: "igw", resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("NAT Gateway"))).toBe(true);
  });

  it("does not suggest NAT Gateway when already present", () => {
    const { pattern, queue } = makePattern("vpc-networking", [
      { resourceId: "vpc", resourceType: RESOURCE_TYPES.EC2_VPC },
      { resourceId: "natgw", resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("NAT Gateway"))).toBe(false);
  });

  it("suggests DLQ and alarms for serverless-api without them", () => {
    const { pattern, queue } = makePattern("serverless-api", [
      { resourceId: "fn", resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION },
      { resourceId: "api", resourceType: RESOURCE_TYPES.APIGATEWAYV2_API },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("Dead Letter Queue"))).toBe(true);
    expect(hints.some((h) => h.includes("CloudWatch Alarms"))).toBe(true);
  });

  it("does not suggest DLQ when SQS queue already present", () => {
    const { pattern, queue } = makePattern("serverless-api", [
      { resourceId: "fn", resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION },
      { resourceId: "api", resourceType: RESOURCE_TYPES.APIGATEWAYV2_API },
      { resourceId: "dlq", resourceType: RESOURCE_TYPES.SQS_QUEUE },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("Dead Letter Queue"))).toBe(false);
  });

  it("suggests Secrets Manager for container-service", () => {
    const { pattern, queue } = makePattern("container-service", [
      { resourceId: "cluster", resourceType: RESOURCE_TYPES.ECS_CLUSTER },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("Secrets Manager"))).toBe(true);
  });

  it("suggests alarms for three-tier-web", () => {
    const { pattern, queue } = makePattern("three-tier-web", [
      { resourceId: "ec2", resourceType: RESOURCE_TYPES.EC2_INSTANCE },
      { resourceId: "rds", resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE },
      { resourceId: "alb", resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints.some((h) => h.includes("CloudWatch Alarms"))).toBe(true);
  });

  it("returns empty for unknown pattern", () => {
    const { pattern, queue } = makePattern("custom-pattern-xyz", [
      { resourceId: "x", resourceType: RESOURCE_TYPES.EC2_INSTANCE },
    ]);

    const hints = architectureAdvisor(pattern, queue);
    expect(hints).toHaveLength(0);
  });
});
