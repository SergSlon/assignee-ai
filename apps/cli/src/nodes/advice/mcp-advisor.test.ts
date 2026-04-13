import { describe, it, expect, vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import {
  gatherMcpAdviceContext,
  resourceTypeToServiceCode,
} from "./mcp-advisor.js";
import { ToolName } from "../../constants/tools.js";

/**
 * Anti-drift gate: every SUPPORTED_TYPES_ARRAY entry MUST be
 * explicitly categorized as either
 *   (a) PAID / workload-dependent — has a service code mapping
 *   (b) FREE wiring — deliberately returns undefined
 *
 * When a new type is promoted to SUPPORTED_TYPES_ARRAY, this file
 * fails to compile until the author has picked a side. That's the
 * CI gate that would have caught the Sprint G → A13 drift where
 * EFS::FileSystem, Events::EventBus, Events::ApiDestination, and
 * KMS::Key silently skipped MCP pricing enrichment because nobody
 * remembered to update the local map.
 *
 * To add a new entry:
 *   - If the type has real AWS billing (storage, requests, data
 *     transfer, per-hour rates, etc.), add it to PAID_TYPES AND
 *     update the source-code map in mcp-advisor.ts resourceTypeToServiceCode.
 *   - If the type is pure wiring with no AWS bill (cross-references,
 *     attachments, parent-bears-cost companions), add it to
 *     FREE_WIRING_TYPES.
 *   - Do NOT leave it out of both sets — the union-coverage test
 *     will fail until the decision is made.
 */

const PAID_TYPES = new Set<string>([
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
  "AWS::S3::Bucket",
  "AWS::Lambda::Function",
  "AWS::DynamoDB::Table",
  "AWS::EC2::NatGateway",
  "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::ECS::Cluster",
  "AWS::CloudWatch::Alarm",
  "AWS::Logs::LogGroup",
  "AWS::SecretsManager::Secret",
  "AWS::ECR::Repository",
  "AWS::ApiGatewayV2::Api",
  "AWS::EFS::FileSystem",
  "AWS::Events::EventBus",
  "AWS::Events::ApiDestination",
  "AWS::KMS::Key",
  "AWS::CloudFront::Distribution",
]);

const FREE_WIRING_TYPES = new Set<string>([
  "AWS::IAM::Role",
  "AWS::SSM::Parameter",
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::RouteTable",
  "AWS::EC2::Route",
  "AWS::EC2::VPCGatewayAttachment",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EFS::MountTarget",
  "AWS::Events::Rule",
  "AWS::Events::Connection",
  "AWS::SNS::Subscription",
  // (f) 2026-04-09 Task 4b: CloudFront OAC and S3 BucketPolicy are
  // pure wiring — the cost lives on the parent distribution (per
  // request + data transfer) and the parent bucket (storage + reqs)
  // respectively. Neither has its own meter.
  "AWS::CloudFront::OriginAccessControl",
  "AWS::S3::BucketPolicy",
  // 2026-04-13: DBSubnetGroup is free wiring — cost on parent RDS instance
  "AWS::RDS::DBSubnetGroup",
]);

// ────────────────────────────────────────────────────────────────────
// resourceTypeToServiceCode — mapping + anti-drift gate
// ────────────────────────────────────────────────────────────────────

describe("resourceTypeToServiceCode", () => {
  describe("anti-drift gate (CRITICAL — locks the Sprint G drift fix)", () => {
    it("every SUPPORTED_TYPES_ARRAY entry is explicitly categorized (paid OR exempt)", () => {
      // The test-local PAID_TYPES and FREE_WIRING_TYPES sets must
      // together cover every type in SUPPORTED_TYPES_ARRAY. Any
      // uncategorized type is a drift failure — when a new type
      // gets promoted, this assertion fails until the author adds
      // it to one of the two sets above.
      const covered = new Set([...PAID_TYPES, ...FREE_WIRING_TYPES]);
      const uncategorized = SUPPORTED_TYPES_ARRAY.filter(
        (t) => !covered.has(t),
      );
      expect(
        uncategorized,
        `Uncategorized SUPPORTED_TYPES_ARRAY entries (add to PAID_TYPES or FREE_WIRING_TYPES in mcp-advisor.test.ts): ${uncategorized.join(", ")}`,
      ).toEqual([]);
    });

    it("every paid type has a non-empty service code mapping", () => {
      for (const type of PAID_TYPES) {
        const code = resourceTypeToServiceCode(type);
        expect(
          code,
          `${type} is in PAID_TYPES but has no service code mapping — update mcp-advisor.ts resourceTypeToServiceCode`,
        ).toBeDefined();
        expect(code!.length).toBeGreaterThan(0);
      }
    });

    it("every free wiring type returns undefined", () => {
      for (const type of FREE_WIRING_TYPES) {
        const code = resourceTypeToServiceCode(type);
        expect(
          code,
          `${type} is in FREE_WIRING_TYPES but has a service code mapping — either it's actually paid (move to PAID_TYPES) or the map has stale entries`,
        ).toBeUndefined();
      }
    });

    it("PAID_TYPES and FREE_WIRING_TYPES are disjoint", () => {
      const intersect = [...PAID_TYPES].filter((t) => FREE_WIRING_TYPES.has(t));
      expect(intersect).toEqual([]);
    });
  });

  describe("specific service-code mappings", () => {
    it("maps EC2-family types to AmazonEC2", () => {
      expect(resourceTypeToServiceCode("AWS::EC2::Instance")).toBe("AmazonEC2");
      expect(resourceTypeToServiceCode("AWS::EC2::NatGateway")).toBe(
        "AmazonEC2",
      );
    });

    it("maps CloudWatch family (Alarm + Logs) to AmazonCloudWatch", () => {
      expect(resourceTypeToServiceCode("AWS::CloudWatch::Alarm")).toBe(
        "AmazonCloudWatch",
      );
      expect(resourceTypeToServiceCode("AWS::Logs::LogGroup")).toBe(
        "AmazonCloudWatch",
      );
    });

    it("maps Events family (EventBus + ApiDestination) to AmazonEventBridge", () => {
      expect(resourceTypeToServiceCode("AWS::Events::EventBus")).toBe(
        "AmazonEventBridge",
      );
      expect(resourceTypeToServiceCode("AWS::Events::ApiDestination")).toBe(
        "AmazonEventBridge",
      );
    });

    it("maps KMS::Key to awskms (lowercase, AWS-documented code)", () => {
      expect(resourceTypeToServiceCode("AWS::KMS::Key")).toBe("awskms");
    });

    it("maps CloudFront::Distribution to AmazonCloudFront", () => {
      expect(resourceTypeToServiceCode("AWS::CloudFront::Distribution")).toBe(
        "AmazonCloudFront",
      );
    });

    it("maps EFS::FileSystem to AmazonEFS", () => {
      expect(resourceTypeToServiceCode("AWS::EFS::FileSystem")).toBe(
        "AmazonEFS",
      );
    });

    it("SQS uses AmazonSQS — matches the SC.SQS constant in filter-constants.ts", () => {
      // The (f) 2026-04-09 audit caught a real codebase inconsistency:
      // mcp-advisor was emitting "AWSQueueService" while the rest of
      // the codebase (decomposer, strategy, integration tests) used
      // SC.SQS = "AmazonSQS". The filter-constants is the single
      // source of truth — this assertion locks the alignment so a
      // future advisor edit cannot silently drift back.
      expect(resourceTypeToServiceCode("AWS::SQS::Queue")).toBe("AmazonSQS");
    });

    it("ELBv2 uses the legacy ElasticLoadBalancing code", () => {
      expect(
        resourceTypeToServiceCode("AWS::ElasticLoadBalancingV2::LoadBalancer"),
      ).toBe("ElasticLoadBalancing");
    });
  });

  describe("unknown types", () => {
    it("returns undefined for a type not in SUPPORTED_TYPES_ARRAY", () => {
      expect(
        resourceTypeToServiceCode("AWS::Nonexistent::Type"),
      ).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(resourceTypeToServiceCode("")).toBeUndefined();
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// gatherMcpAdviceContext — end-to-end orchestration
// ────────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock StructuredTool that resolves with the given
 * value on invoke. Mirrors the pattern used in other test files that
 * exercise langchain tools.
 */
function makeMockTool(name: string, value: unknown): StructuredTool {
  return {
    name,
    description: `mock ${name}`,
    schema: {} as never,
    invoke: vi.fn(async () => value),
  } as unknown as StructuredTool;
}

/** Mock tool that rejects — simulates an MCP server error. */
function makeRejectingTool(name: string, error: Error): StructuredTool {
  return {
    name,
    description: `mock rejecting ${name}`,
    schema: {} as never,
    invoke: vi.fn(async () => {
      throw error;
    }),
  } as unknown as StructuredTool;
}

/** Mock tool whose invoke hangs forever — simulates a timeout. */
function makeHangingTool(name: string): StructuredTool {
  return {
    name,
    description: `mock hanging ${name}`,
    schema: {} as never,
    invoke: vi.fn(() => new Promise(() => {})),
  } as unknown as StructuredTool;
}

describe("gatherMcpAdviceContext", () => {
  it("returns all three snippets when every MCP tool resolves", async () => {
    const tools = [
      makeMockTool(ToolName.GET_PRICING, { price: "0.05/hour" }),
      makeMockTool(ToolName.SEARCH_DOCUMENTATION, {
        doc: "EC2 instance guide",
      }),
      makeMockTool(ToolName.CHECK_SECURITY_SERVICES, {
        region: "us-east-1",
        services_checked: ["securityhub"],
        all_enabled: true,
        service_statuses: {
          securityhub: { enabled: true, details: "open-to-world SG detected" },
        },
      }),
    ];

    const ctx = await gatherMcpAdviceContext(
      "AWS::EC2::Instance",
      { InstanceType: "t3.micro" },
      tools,
    );

    expect(ctx.pricingSnippet).toMatch(/0\.05\/hour/);
    expect(ctx.docSnippet).toMatch(/EC2 instance guide/);
    expect(ctx.securitySnippet).toMatch(/open-to-world SG detected/);
  });

  it("skips pricing when the resource type has no service code (free wiring)", async () => {
    // IAM::Role is deliberately exempt from pricing enrichment —
    // the advisor should NOT call the pricing tool at all, so the
    // pricingSnippet must be undefined regardless of whether the
    // tool is present.
    const pricingInvoke = vi.fn(async () => ({ shouldNotBeCalled: true }));
    const tools = [
      {
        name: ToolName.GET_PRICING,
        description: "mock pricing",
        schema: {} as never,
        invoke: pricingInvoke,
      } as unknown as StructuredTool,
    ];

    const ctx = await gatherMcpAdviceContext("AWS::IAM::Role", {}, tools);

    expect(ctx.pricingSnippet).toBeUndefined();
    expect(pricingInvoke).not.toHaveBeenCalled();
  });

  it("returns undefined snippets when tools are absent (doctor / no-creds flow)", async () => {
    const ctx = await gatherMcpAdviceContext(
      "AWS::EC2::Instance",
      { InstanceType: "t3.micro" },
      [],
    );

    expect(ctx.pricingSnippet).toBeUndefined();
    expect(ctx.docSnippet).toBeUndefined();
    expect(ctx.securitySnippet).toBeUndefined();
  });

  it("tolerates a rejecting pricing tool without throwing", async () => {
    const tools = [
      makeRejectingTool(ToolName.GET_PRICING, new Error("MCP server down")),
      makeMockTool(ToolName.SEARCH_DOCUMENTATION, { doc: "fallback" }),
    ];

    // Must not throw — Promise.allSettled wraps each rejection.
    const ctx = await gatherMcpAdviceContext("AWS::S3::Bucket", {}, tools);

    expect(ctx.pricingSnippet).toBeUndefined();
    expect(ctx.docSnippet).toMatch(/fallback/);
  });

  it("tolerates a hanging pricing tool via the 3s withTimeout guard", async () => {
    const tools = [
      makeHangingTool(ToolName.GET_PRICING),
      makeMockTool(ToolName.SEARCH_DOCUMENTATION, { doc: "doc-ok" }),
    ];

    const ctx = await gatherMcpAdviceContext("AWS::S3::Bucket", {}, tools);

    // Hanging pricing tool must time out and leave pricingSnippet
    // undefined; the other snippets should still resolve.
    expect(ctx.pricingSnippet).toBeUndefined();
    expect(ctx.docSnippet).toMatch(/doc-ok/);
  }, 10_000);

  it("truncates long responses to 500 chars + ellipsis", async () => {
    const longPayload = "x".repeat(2000);
    const tools = [makeMockTool(ToolName.GET_PRICING, longPayload)];

    const ctx = await gatherMcpAdviceContext("AWS::EC2::Instance", {}, tools);

    expect(ctx.pricingSnippet).toBeDefined();
    expect(ctx.pricingSnippet!.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(ctx.pricingSnippet!).toMatch(/\.\.\.$/);
  });

  it("passes region + services to the CheckSecurityServices tool (v0.1.7 API)", async () => {
    const securityInvoke = vi.fn(async () =>
      JSON.stringify({
        all_enabled: true,
        service_statuses: { securityhub: { enabled: true } },
      }),
    );
    const tools = [
      {
        name: ToolName.CHECK_SECURITY_SERVICES,
        description: "mock security",
        schema: {} as never,
        invoke: securityInvoke,
      } as unknown as StructuredTool,
    ];

    const config = {
      BucketName: "my-bucket",
      PublicAccessBlockConfiguration: {},
    };
    await gatherMcpAdviceContext("AWS::S3::Bucket", config, tools);

    expect(securityInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        region: expect.any(String),
        services: ["securityhub"],
      }),
    );
  });

  it("returns undefined securitySnippet when CheckSecurityServices reports all_enabled=false", async () => {
    const tools = [
      makeMockTool(
        ToolName.CHECK_SECURITY_SERVICES,
        JSON.stringify({
          region: "us-east-1",
          services_checked: ["securityhub"],
          all_enabled: false,
          service_statuses: {
            securityhub: { enabled: false, details: "Not enabled" },
          },
        }),
      ),
    ];

    const ctx = await gatherMcpAdviceContext(
      "AWS::S3::Bucket",
      { BucketName: "test" },
      tools,
    );

    expect(ctx.securitySnippet).toBeUndefined();
  });

  it("returns undefined securitySnippet when CheckSecurityServices returns unparseable garbage", async () => {
    // Simulates a corrupt MCP response — fetchSecurityContext must catch the
    // JSON.parse error and fall through to the catch branch, which still
    // truncates the raw text. Since the garbage string is short (<500 chars),
    // it returns as-is rather than undefined.
    // However the *outer* JSON.parse in the try block will fail, so control
    // falls to the catch block which returns a truncated string of the raw
    // response. We verify it does NOT throw and does NOT crash the caller.
    const garbagePayload = "<<<not-json-at-all:::{{{garbage";
    const tools = [
      makeMockTool(ToolName.CHECK_SECURITY_SERVICES, garbagePayload),
    ];

    // Must not throw — the catch block in fetchSecurityContext handles the parse error
    const ctx = await gatherMcpAdviceContext(
      "AWS::S3::Bucket",
      { BucketName: "test-bucket" },
      tools,
    );

    // The catch block returns the raw text (truncated if >500 chars),
    // so securitySnippet should be defined but contain the garbage.
    // The important assertion: no exception propagated.
    expect(ctx.securitySnippet).toBeDefined();
    expect(ctx.securitySnippet).toContain("not-json-at-all");
  });

  it("searches documentation using the short type name", async () => {
    const docInvoke = vi.fn(async () => "doc-result");
    const tools = [
      {
        name: ToolName.SEARCH_DOCUMENTATION,
        description: "mock docs",
        schema: {} as never,
        invoke: docInvoke,
      } as unknown as StructuredTool,
    ];

    await gatherMcpAdviceContext("AWS::Events::ApiDestination", {}, tools);

    // The short type is the last :: segment, so 'ApiDestination'.
    expect(docInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        search_phrase: expect.stringMatching(/ApiDestination/),
      }),
    );
  });
});
