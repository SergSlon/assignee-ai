/**
 * Unit tests for the apply_plan MCP tool.
 *
 * @see Story 20.3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ExecutionStatus, CHECKPOINT_VERSION } from "@assignee/core";
import { registerApplyPlan } from "../tools/apply-plan.js";
import type { GraphContext } from "../services/graph-init.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCheckpointJSON(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: 72,
    runId: "11111111-1111-1111-1111-111111111111",
    userIntent: "Create an S3 bucket named test-bucket",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "test-bucket" },
    estimatedMonthlyCost: "$0.00",
    preflightPassed: true,
    elicitedOptions: {},
    ...overrides,
  });
}

function makeExpiredCheckpointJSON(): string {
  const pastDate = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
  return makeCheckpointJSON({ created_at: pastDate });
}

function makeMockGraphContext(
  finalState: Record<string, unknown> = {},
  stateSequence?: { next: string[] }[],
): GraphContext {
  let getStateCallCount = 0;
  const defaultFinalState = {
    executionStatus: ExecutionStatus.SUCCESS,
    resourceArn: "arn:aws:s3:::test-bucket",
    resourceType: "AWS::S3::Bucket",
    estimatedMonthlyCost: "$0.00",
    securityFindings: [],
    completedResources: [],
    ...finalState,
  };

  // Default: first getState returns next=[], meaning provisioning done in one step
  const defaultSequence = stateSequence ?? [{ next: [] }];

  return {
    graph: {
      invoke: vi.fn().mockResolvedValue(defaultFinalState),
      getState: vi.fn().mockImplementation(() => {
        const idx = Math.min(getStateCallCount, defaultSequence.length - 1);
        getStateCallCount++;
        return Promise.resolve({
          values: defaultFinalState,
          next: defaultSequence[idx]!.next,
        });
      }),
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

async function createTestClient(ctx?: GraphContext) {
  const server = new McpServer({
    name: "apply-plan-test",
    version: "0.1.0",
  });

  registerApplyPlan(server, ctx);

  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { server, client };
}

// ── Mock fs for checkpoint loading ───────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

async function setCheckpointFile(content: string) {
  const { readFile } = await import("node:fs/promises");
  (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(content);
}

async function setCheckpointFileNotFound() {
  const { readFile } = await import("node:fs/promises");
  (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("ENOENT: no such file or directory"),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("apply_plan tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("safety gate (confirmed parameter)", () => {
    it("should reject when confirmed is false with isError: true", async () => {
      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: false,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.error).toBe(true);
      expect(body.message).toContain("explicit confirmation");
      expect(body.hint).toBeDefined();
    });

    it("should include hint about reviewing the plan first", async () => {
      const { client } = await createTestClient();

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: false,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.hint).toContain("plan_resource");
    });
  });

  describe("checkpoint loading", () => {
    it("should return error when checkpoint file is not found", async () => {
      await setCheckpointFileNotFound();
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/nonexistent.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.error).toBe(true);
      expect(body.message).toContain("not found");
    });

    it("should return error when checkpoint is expired", async () => {
      await setCheckpointFile(makeExpiredCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/expired.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("expired");
    });

    it("should return error when checkpoint has invalid JSON", async () => {
      await setCheckpointFile("not valid json {{{");
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/corrupt.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("Corrupt");
    });

    it("should return error when checkpoint has no desiredState", async () => {
      await setCheckpointFile(makeCheckpointJSON({ desiredState: {} }));
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/empty-state.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("desiredState");
    });

    it("should return error when checkpoint did not pass preflight", async () => {
      await setCheckpointFile(makeCheckpointJSON({ preflightPassed: false }));
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/no-preflight.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("preflight");
    });
  });

  describe("successful provisioning", () => {
    it("should invoke graph and return ARN on success", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.status).toBe("SUCCESS");
      expect(body.resourceArn).toBe("arn:aws:s3:::test-bucket");
      expect(body.resourceType).toBe("AWS::S3::Bucket");
      expect(body.estimatedMonthlyCost).toBe("$0.00");
      expect(body.runId).toBe("11111111-1111-1111-1111-111111111111");
    });

    it("should include securityFindings array in response", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const findings = [
        { rule: "S3-001", severity: "HIGH", message: "Bucket is public" },
      ];
      const ctx = makeMockGraphContext({ securityFindings: findings });
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.securityFindings).toEqual(findings);
    });

    it("should include empty securityFindings when none exist", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext({ securityFindings: undefined });
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.securityFindings).toEqual([]);
    });

    it("should pass autoApprove: true to graph invoke", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(invokeCall[0]).toMatchObject({ autoApprove: true });
    });

    it("should set executionMode to APPLY", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(invokeCall[0]).toMatchObject({ executionMode: "apply" });
    });
  });

  describe("provisioning failure", () => {
    it("should return structured error on provisioning failure", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext({
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: "CloudControl API error: access denied",
      });
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.error).toBe(true);
      expect(body.message).toContain("access denied");
      expect(body.status).toBe(ExecutionStatus.FAILED);
    });

    it("should return default message when errorMessage is absent", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext({
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: undefined,
      });
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toBe("Provisioning failed");
    });

    it("should handle graph invoke throwing an error", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network timeout"),
      );
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("Network timeout");
    });
  });

  describe("compound resource provisioning", () => {
    it("should return completedResources array for compound resources", async () => {
      await setCheckpointFile(
        makeCheckpointJSON({
          resourceQueue: [
            {
              resourceId: "vpc-1",
              resourceType: "AWS::EC2::VPC",
              displayName: "My VPC",
              desiredState: {},
            },
            {
              resourceId: "subnet-1",
              resourceType: "AWS::EC2::Subnet",
              displayName: "Public Subnet",
              desiredState: {},
            },
          ],
        }),
      );
      const completedResources = [
        {
          resourceId: "vpc-1",
          resourceType: "AWS::EC2::VPC",
          arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-123",
        },
        {
          resourceId: "subnet-1",
          resourceType: "AWS::EC2::Subnet",
          arn: "arn:aws:ec2:us-east-1:123:subnet/subnet-456",
        },
      ];

      // Two provisioning iterations: first returns next=["resource_provisioner"], second returns next=[]
      const ctx = makeMockGraphContext({ completedResources }, [
        { next: ["resource_provisioner"] },
        { next: [] },
      ]);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/compound-checkpoint.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.status).toBe("SUCCESS");
      expect(body.completedResources).toEqual(completedResources);
    });

    it("should call graph.invoke multiple times for compound resources", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext({}, [
        { next: ["resource_provisioner"] },
        { next: [] },
      ]);
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      // Phase 1 invoke + 2 provisioning loop invokes = 3 total
      expect(ctx.graph.invoke).toHaveBeenCalledTimes(3);
    });
  });

  describe("graph context not initialized", () => {
    it("should return error when no graph context is provided", async () => {
      const { client } = await createTestClient(/* no ctx */);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("graph context not initialized");
    });
  });
});
