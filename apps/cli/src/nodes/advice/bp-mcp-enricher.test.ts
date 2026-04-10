/**
 * Tests for bp-mcp-enricher — covers happy path, degraded MCP responses,
 * server unavailability, deduplication against static BP findings, and
 * integration with bp-evaluator output shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import type { BPFinding } from "@assignee/best-practices";
import { enrichBpWithMcp } from "./bp-mcp-enricher.js";
import { ToolName } from "../../constants/tools.js";

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
    const securityTool = makeTool(ToolName.CHECK_SECURITY_SERVICES, async () =>
      JSON.stringify({
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
    const securityTool = makeTool(ToolName.CHECK_SECURITY_SERVICES, async () =>
      JSON.stringify({
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
    const securityTool = makeTool(ToolName.CHECK_SECURITY_SERVICES, async () =>
      JSON.stringify({
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
      ToolName.CHECK_SECURITY_SERVICES,
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
    const securityTool = makeTool(ToolName.CHECK_SECURITY_SERVICES, async () =>
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
    const securityTool = makeTool(
      ToolName.CHECK_SECURITY_SERVICES,
      async () => {
        throw new Error("ECONNREFUSED");
      },
    );
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

  it("integrates with the BPFinding output shape from bp-evaluator", async () => {
    const securityTool = makeTool(ToolName.CHECK_SECURITY_SERVICES, async () =>
      JSON.stringify({
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
