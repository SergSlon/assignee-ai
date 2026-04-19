/**
 * Tests for bp-mcp-enricher — covers happy path, degraded MCP responses,
 * server unavailability, deduplication against static BP findings, and
 * integration with bp-evaluator output shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import type { BPFinding } from "@assignee/best-practices";
import { enrichBpWithMcp } from "./bp-mcp-enricher/orchestrator.js";
import { ToolName } from "@/constants/tools.js";

/**
 * Build a minimal StructuredTool stub with a mocked `invoke` method.
 * Using a plain object (not a real LangChain tool) keeps the test hermetic.
 */
function makeTool(
  name: string,
  impl: (input: unknown) => Promise<unknown>,
): StructuredTool {
  return {
    name,
    invoke: vi.fn(impl),
  } as unknown as StructuredTool;
}

const RESOURCE_TYPE = "AWS::S3::Bucket";
const DESIRED_STATE: Record<string, unknown> = {
  BucketName: "assignee-test-bucket-123456789012",
  PublicAccessBlockConfiguration: { BlockPublicAcls: false },
};

const STATIC_FINDING: BPFinding = {
  practiceId: "BP-S3-001",
  title: "S3 bucket must block public ACLs",
  severity: "HIGH",
  category: "security",
  message: "PublicAccessBlockConfiguration.BlockPublicAcls should be true",
  remediation: "Set BlockPublicAcls=true",
  blocking: false,
  propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
};

describe("enrichBpWithMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns extra findings from the Well-Architected security posture tool", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({
        service: "securityhub",
        enabled: true,
        findings: [
          {
            severity: "HIGH",
            title: "Bucket versioning disabled",
            recommendation: "Enable versioning for data protection",
            property: "VersioningConfiguration.Status",
          },
        ],
      }),
    );
    const docsTool = makeTool(
      ToolName.SEARCH_DOCUMENTATION,
      async () => "ignored",
    );

    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [STATIC_FINDING],
      [securityTool, docsTool],
    );

    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({
      severity: "HIGH",
      category: "security",
      propertyPath: "VersioningConfiguration.Status",
      title: "Bucket versioning disabled",
      remediation: "Enable versioning for data protection",
      blocking: false,
    });
    expect(extras[0]!.practiceId).toContain("MCP-SEC-");
  });

  it("deduplicates findings already covered by static BP rules via propertyPath", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({
        service: "securityhub",
        enabled: true,
        findings: [
          {
            severity: "HIGH",
            title: "BlockPublicAcls disabled",
            recommendation: "Enable BlockPublicAcls",
            // Exact propertyPath match with STATIC_FINDING → must be skipped
            property: "PublicAccessBlockConfiguration.BlockPublicAcls",
          },
          {
            severity: "MEDIUM",
            title: "Logging off",
            recommendation: "Enable access logging",
            property: "LoggingConfiguration",
          },
        ],
      }),
    );

    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [STATIC_FINDING],
      [securityTool],
    );

    expect(extras).toHaveLength(1);
    expect(extras[0]!.propertyPath).toBe("LoggingConfiguration");
  });

  it("maps MCP severities and defaults unknown values to INFO", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({
        service: "securityhub",
        enabled: true,
        findings: [
          {
            severity: "CRITICAL",
            title: "a",
            recommendation: "r1",
            property: "p1",
          },
          {
            severity: "high",
            title: "b",
            recommendation: "r2",
            property: "p2",
          },
          {
            severity: "Medium",
            title: "c",
            recommendation: "r3",
            property: "p3",
          },
          {
            severity: "weird",
            title: "d",
            recommendation: "r4",
            property: "p4",
          },
          { title: "e", recommendation: "r5", property: "p5" },
        ],
      }),
    );

    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [securityTool],
    );

    expect(extras.map((f) => f.severity)).toEqual([
      "CRITICAL",
      "HIGH",
      "MEDIUM",
      "INFO",
      "INFO",
    ]);
  });

  it("returns [] gracefully when the security MCP tool is not registered", async () => {
    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [STATIC_FINDING],
      [], // no tools available
    );
    expect(extras).toEqual([]);
  });

  it("returns [] gracefully when MCP returns malformed JSON", async () => {
    const securityTool = makeTool(
      ToolName.GET_SECURITY_FINDINGS,
      async () => "this is not json {{{",
    );
    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [securityTool],
    );
    expect(extras).toEqual([]);
  });

  it("returns [] gracefully when MCP returns an unexpected shape (no findings array)", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({ results: "other shape" }),
    );
    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [securityTool],
    );
    expect(extras).toEqual([]);
  });

  it("returns [] gracefully when the MCP tool throws (server unavailable)", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () => {
      throw new Error("ECONNREFUSED");
    });
    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [securityTool],
    );
    expect(extras).toEqual([]);
  });

  it("docs MCP never emits findings even with results (LLM handles doc synthesis)", async () => {
    const docsTool = makeTool(ToolName.SEARCH_DOCUMENTATION, async () =>
      JSON.stringify({ results: ["some doc"] }),
    );

    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [docsTool],
    );
    expect(extras).toEqual([]);
  });

  it("returns [] gracefully when enabled is false (service not active)", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({
        service: "securityhub",
        enabled: false,
        message: "Security Hub is not enabled in us-east-1.",
      }),
    );
    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [],
      [securityTool],
    );
    expect(extras).toEqual([]);
  });

  it("integrates with the BPFinding output shape from bp-evaluator", async () => {
    const securityTool = makeTool(ToolName.GET_SECURITY_FINDINGS, async () =>
      JSON.stringify({
        service: "securityhub",
        enabled: true,
        findings: [
          {
            severity: "HIGH",
            title: "No encryption at rest",
            recommendation: "Enable SSE-KMS",
            property: "BucketEncryption",
          },
        ],
      }),
    );

    const extras = await enrichBpWithMcp(
      RESOURCE_TYPE,
      DESIRED_STATE,
      [STATIC_FINDING],
      [securityTool],
    );

    // Every extra must satisfy the BPFinding contract consumed downstream.
    for (const f of extras) {
      expect(f).toEqual(
        expect.objectContaining({
          practiceId: expect.any(String),
          title: expect.any(String),
          severity: expect.any(String),
          category: "security",
          message: expect.any(String),
          remediation: expect.any(String),
          blocking: false,
        }),
      );
    }
  });
});

// ── CheckStorageEncryption + CheckNetworkSecurity (Story 45.4) ─────────

describe("enrichBpWithMcp — CheckStorageEncryption", () => {
  it("returns storage encryption findings for S3 bucket", async () => {
    const storageTool = makeTool(ToolName.CHECK_STORAGE_ENCRYPTION, async () =>
      JSON.stringify({
        result: {
          resource_details: [
            {
              resource_arn: "arn:aws:s3:::test-bucket",
              compliant: false,
              issues: ["Default encryption not enabled"],
              recommendations: ["Enable SSE-S3 or SSE-KMS encryption"],
            },
          ],
        },
      }),
    );

    const extras = await enrichBpWithMcp(
      "AWS::S3::Bucket",
      { BucketName: "test-bucket" },
      [],
      [storageTool],
    );

    expect(extras).toHaveLength(1);
    expect(extras[0]!.title).toBe("Default encryption not enabled");
    expect(extras[0]!.practiceId).toMatch(/^MCP-STOR-/);
    expect(extras[0]!.category).toBe("security");
    expect(extras[0]!.message).toBe("Enable SSE-S3 or SSE-KMS encryption");
  });

  it("skips storage check for non-storage resource types (Lambda)", async () => {
    const storageTool = makeTool(
      ToolName.CHECK_STORAGE_ENCRYPTION,
      async () => {
        throw new Error("should not be called");
      },
    );

    const extras = await enrichBpWithMcp(
      "AWS::Lambda::Function",
      { FunctionName: "my-fn" },
      [],
      [storageTool],
    );

    expect(storageTool.invoke).not.toHaveBeenCalled();
    expect(extras).toEqual([]);
  });

  it("gracefully handles missing storage encryption tool", async () => {
    const extras = await enrichBpWithMcp(
      "AWS::S3::Bucket",
      { BucketName: "test" },
      [],
      [], // no tools
    );
    expect(extras).toEqual([]);
  });

  it("gracefully handles error from storage encryption tool", async () => {
    const failingTool = makeTool(
      ToolName.CHECK_STORAGE_ENCRYPTION,
      async () => {
        throw new Error("MCP server unreachable");
      },
    );

    const extras = await enrichBpWithMcp(
      "AWS::S3::Bucket",
      { BucketName: "test" },
      [],
      [failingTool],
    );
    expect(extras).toEqual([]);
  });
});

describe("enrichBpWithMcp — CheckNetworkSecurity", () => {
  it("returns network security findings for ELBv2", async () => {
    const networkTool = makeTool(ToolName.CHECK_NETWORK_SECURITY, async () =>
      JSON.stringify({
        result: {
          resource_details: [
            {
              resource_arn:
                "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb",
              compliant: false,
              issues: [
                "HTTPS listener not configured",
                "SSL/TLS policy outdated",
              ],
              recommendations: [
                "Add HTTPS listener on port 443",
                "Update to TLS 1.3 security policy",
              ],
            },
          ],
        },
      }),
    );

    const extras = await enrichBpWithMcp(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      { Name: "my-alb" },
      [],
      [networkTool],
    );

    expect(extras).toHaveLength(2);
    expect(extras[0]!.title).toBe("HTTPS listener not configured");
    expect(extras[0]!.practiceId).toMatch(/^MCP-NET-/);
    expect(extras[1]!.title).toBe("SSL/TLS policy outdated");
  });

  it("skips network check for non-network resource types (DynamoDB)", async () => {
    const networkTool = makeTool(ToolName.CHECK_NETWORK_SECURITY, async () => {
      throw new Error("should not be called");
    });

    const extras = await enrichBpWithMcp(
      "AWS::DynamoDB::Table",
      { TableName: "test" },
      [],
      [networkTool],
    );

    expect(networkTool.invoke).not.toHaveBeenCalled();
    expect(extras).toEqual([]);
  });

  it("deduplicates findings already in static rules", async () => {
    const networkTool = makeTool(ToolName.CHECK_NETWORK_SECURITY, async () =>
      JSON.stringify({
        result: {
          findings: [
            {
              severity: "HIGH",
              title: "HTTPS required",
              recommendation: "Enable HTTPS",
              property: undefined,
            },
          ],
        },
      }),
    );

    const staticRule: BPFinding = {
      practiceId: "MCP-NET-HTTPS-required",
      title: "HTTPS required",
      severity: "HIGH",
      category: "security",
      message: "Enable HTTPS",
      remediation: "Enable HTTPS",
      blocking: false,
    };

    const extras = await enrichBpWithMcp(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      { Name: "my-alb" },
      [staticRule],
      [networkTool],
    );

    // Deduplicated by practiceId
    expect(extras).toEqual([]);
  });
});
