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
import {
  registerApplyPlan,
  _resetActiveApplies,
  _resetBPCache,
} from "../tools/apply-plan.js";
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

// ── Mock BP loading so re-evaluation doesn't block on minimal test fixtures ──
// NOTE: Default impls re-installed in beforeEach because mockReset:true wipes
// vi.fn implementations between tests.

vi.mock("@assignee/best-practices", () => ({
  loadBestPractices: vi.fn(),
  evaluateTriggers: vi.fn(),
}));

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
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetActiveApplies();
    _resetBPCache();
    const bp = await import("@assignee/best-practices");
    vi.mocked(bp.loadBestPractices).mockReturnValue([]);
    vi.mocked(bp.evaluateTriggers).mockReturnValue([]);
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

  describe("concurrency guard", () => {
    it("should reject a second apply on the same checkpoint while first is in progress", async () => {
      await setCheckpointFile(makeCheckpointJSON());

      // Create a graph context where invoke blocks until we release it
      let resolveInvoke!: (val: Record<string, unknown>) => void;
      const invokePromise = new Promise<Record<string, unknown>>((resolve) => {
        resolveInvoke = resolve;
      });

      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockReturnValue(invokePromise),
          getState: vi.fn().mockResolvedValue({
            values: {
              executionStatus: ExecutionStatus.SUCCESS,
              resourceArn: "arn:aws:s3:::test-bucket",
              resourceType: "AWS::S3::Bucket",
              estimatedMonthlyCost: "$0.00",
              securityFindings: [],
              completedResources: [],
            },
            next: [],
          }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestClient(ctx);

      // Start first apply (will block on invoke)
      const firstApply = client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      // Give the first call a tick to enter the handler and acquire the lock
      await new Promise((r) => setTimeout(r, 50));

      // Second apply on the same checkpoint should be rejected immediately
      const secondResult = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });

      expect(secondResult.isError).toBe(true);
      const body = JSON.parse(
        (secondResult.content as Array<{ type: string; text: string }>)[0]!
          .text,
      );
      expect(body.message).toContain("already being applied");

      // Resolve the first apply so it completes cleanly
      resolveInvoke({
        executionStatus: ExecutionStatus.SUCCESS,
        resourceArn: "arn:aws:s3:::test-bucket",
        resourceType: "AWS::S3::Bucket",
        estimatedMonthlyCost: "$0.00",
      });
      await firstApply;
    });

    it("should release the lock after apply completes (allow re-apply)", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      // First apply should succeed
      const first = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });
      expect(first.isError).toBeUndefined();

      // Second apply on same checkpoint should also succeed (lock released)
      const second = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });
      expect(second.isError).toBeUndefined();
    });

    it("should release the lock even when provisioning fails", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("AWS error"),
      );
      const { client } = await createTestClient(ctx);

      // First apply fails
      const first = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });
      expect(first.isError).toBe(true);

      // Mock a success for the retry
      (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockResolvedValue({
        executionStatus: ExecutionStatus.SUCCESS,
        resourceArn: "arn:aws:s3:::test-bucket",
        resourceType: "AWS::S3::Bucket",
        estimatedMonthlyCost: "$0.00",
        securityFindings: [],
        completedResources: [],
      });

      // Second apply should succeed (lock released despite failure)
      const second = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/checkpoint.json",
          confirmed: true,
        },
      });
      expect(second.isError).toBeUndefined();
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

  describe("compound provisioning and timeout (Story E2E.2)", () => {
    it("should use recursionLimit of 500 in graph config", async () => {
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

      // Verify the config passed to graph.invoke includes recursionLimit: 500
      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      const config = invokeCall[1] as {
        recursionLimit: number;
        configurable: Record<string, string>;
      };
      expect(config.recursionLimit).toBe(500);
      expect(config.configurable).toBeDefined();
      expect(config.configurable["thread_id"]).toContain("mcp-apply");
    });

    it("should handle compound pattern with multiple resources", async () => {
      await setCheckpointFile(
        makeCheckpointJSON({
          resourceQueue: [
            {
              resourceId: "res-1",
              resourceType: "AWS::S3::Bucket",
              displayName: "Bucket 1",
              desiredState: {},
            },
            {
              resourceId: "res-2",
              resourceType: "AWS::Lambda::Function",
              displayName: "Function 1",
              desiredState: {},
            },
            {
              resourceId: "res-3",
              resourceType: "AWS::DynamoDB::Table",
              displayName: "Table 1",
              desiredState: {},
            },
          ],
        }),
      );

      const completedResources = [
        {
          resourceId: "res-1",
          resourceType: "AWS::S3::Bucket",
          arn: "arn:aws:s3:::bucket-1",
        },
        {
          resourceId: "res-2",
          resourceType: "AWS::Lambda::Function",
          arn: "arn:aws:lambda:us-east-1:123:function:fn-1",
        },
        {
          resourceId: "res-3",
          resourceType: "AWS::DynamoDB::Table",
          arn: "arn:aws:dynamodb:us-east-1:123:table/table-1",
        },
      ];

      // Simulate 3-resource provisioning loop: three iterations with next nodes, then empty
      const ctx = makeMockGraphContext({ completedResources }, [
        { next: ["resource_provisioner"] },
        { next: ["resource_provisioner"] },
        { next: ["resource_provisioner"] },
        { next: [] },
      ]);
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/compound-3-resources.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.status).toBe("SUCCESS");
      expect(body.completedResources).toHaveLength(3);
      expect(body.completedResources).toEqual(completedResources);

      // Phase 1 invoke + 4 provisioning loop invokes (3 with next + 1 final) = 5 total
      expect(ctx.graph.invoke).toHaveBeenCalledTimes(5);
    });

    it("should return TIMEOUT error when provisioning exceeds 10 minutes", async () => {
      await setCheckpointFile(makeCheckpointJSON());

      // Track how many times graph.invoke is called. On the 2nd loop invoke,
      // advance time past the 10-minute timeout so the NEXT while-loop check triggers.
      const realDateNow = Date.now.bind(Date);
      let timeOffset = 0;
      vi.spyOn(Date, "now").mockImplementation(
        () => realDateNow() + timeOffset,
      );

      let invokeCount = 0;
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockImplementation(() => {
            invokeCount++;
            // After the phase-1 invoke (call 1) and the first loop invoke (call 2),
            // jump time forward past 10 minutes so the next while-check triggers timeout
            if (invokeCount >= 2) {
              timeOffset = 10 * 60 * 1000 + 1;
            }
            return Promise.resolve({});
          }),
          getState: vi.fn().mockResolvedValue({
            values: { executionStatus: ExecutionStatus.SUCCESS },
            next: ["resource_provisioner"], // Always has more work
          }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      try {
        const { client } = await createTestClient(ctx);

        const result = await client.callTool({
          name: "apply_plan",
          arguments: {
            checkpointPath: "/tmp/timeout-checkpoint.json",
            confirmed: true,
          },
        });

        expect(result.isError).toBe(true);
        const body = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0]!.text,
        );
        expect(body.status).toBe("TIMEOUT");
        expect(body.message).toContain("timed out");
        expect(body.message).toContain("600s");
      } finally {
        vi.spyOn(Date, "now").mockRestore();
      }
    });

    it("should handle partial success in compound provisioning", async () => {
      await setCheckpointFile(
        makeCheckpointJSON({
          resourceQueue: [
            {
              resourceId: "res-1",
              resourceType: "AWS::S3::Bucket",
              displayName: "Bucket 1",
              desiredState: {},
            },
            {
              resourceId: "res-2",
              resourceType: "AWS::Lambda::Function",
              displayName: "Function 1",
              desiredState: {},
            },
            {
              resourceId: "res-3",
              resourceType: "AWS::DynamoDB::Table",
              displayName: "Table 1",
              desiredState: {},
            },
          ],
        }),
      );

      // Simulate: 2 resources succeed, then graph invoke throws on the 3rd
      let invokeCallCount = 0;
      const ctx: GraphContext = {
        graph: {
          invoke: vi.fn().mockImplementation(() => {
            invokeCallCount++;
            // Phase 1 invoke + 2 successful loop invokes, then fail on 3rd loop invoke
            if (invokeCallCount <= 3) {
              return Promise.resolve({
                executionStatus: ExecutionStatus.SUCCESS,
                completedResources: [
                  {
                    resourceId: "res-1",
                    resourceType: "AWS::S3::Bucket",
                    arn: "arn:aws:s3:::bucket-1",
                  },
                  {
                    resourceId: "res-2",
                    resourceType: "AWS::Lambda::Function",
                    arn: "arn:aws:lambda:us-east-1:123:function:fn-1",
                  },
                ],
              });
            }
            return Promise.reject(
              new Error(
                "CloudControl API error: DynamoDB table creation failed — limit exceeded",
              ),
            );
          }),
          getState: vi.fn().mockImplementation(() => {
            // First two getState calls: more work to do. Third: would continue but invoke fails.
            return Promise.resolve({
              values: {
                executionStatus: ExecutionStatus.SUCCESS,
                completedResources: [
                  {
                    resourceId: "res-1",
                    resourceType: "AWS::S3::Bucket",
                    arn: "arn:aws:s3:::bucket-1",
                  },
                  {
                    resourceId: "res-2",
                    resourceType: "AWS::Lambda::Function",
                    arn: "arn:aws:lambda:us-east-1:123:function:fn-1",
                  },
                ],
              },
              next: ["resource_provisioner"],
            });
          }),
        },
        cleanup: vi.fn().mockResolvedValue(undefined),
      };

      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/partial-success.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("DynamoDB table creation failed");
    });
  });

  describe("path validation edge cases", () => {
    it("should reject path traversal with '..' in checkpoint path", async () => {
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/../etc/passwd",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("Invalid checkpoint path");
    });

    it("should reject path outside allowed directories", async () => {
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/home/user/malicious.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("Invalid checkpoint path");
    });

    it("should accept path under /var/", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/var/assignee/checkpoint.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      // Should succeed (path is valid), so no "Invalid checkpoint path" error
      expect(body.status).toBe("SUCCESS");
    });

    it("should accept path containing 'assignee' anywhere", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/home/user/.assignee/checkpoints/cp.json",
          confirmed: true,
        },
      });

      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      // Should succeed (path contains 'assignee'), so no path validation error
      expect(body.status).toBe("SUCCESS");
    });
  });

  describe("checkpoint error handling", () => {
    it("should return CheckpointError message when checkpoint throws CheckpointError", async () => {
      const { readFile } = await import("node:fs/promises");
      // Simulate invalid checkpoint schema by providing JSON missing required fields
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify({ invalid: true }),
      );

      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/bad-schema.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      // CheckpointError from invalid schema should be caught
      expect(body.error).toBe(true);
    });

    it("should return generic message when checkpoint throws non-CheckpointError", async () => {
      const { readFile } = await import("node:fs/promises");
      (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/missing.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("not found");
    });
  });

  describe("provisioning loop edge cases", () => {
    it("should pass resourceQueue from checkpoint to graph invoke", async () => {
      const resourceQueue = [
        {
          resourceId: "res-1",
          resourceType: "AWS::EC2::VPC",
          displayName: "VPC 1",
          desiredState: {},
        },
      ];
      await setCheckpointFile(makeCheckpointJSON({ resourceQueue }));
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/queue-checkpoint.json",
          confirmed: true,
        },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(invokeCall[0]).toMatchObject({
        resourceQueue,
        checkpointResumed: true,
      });
    });

    it("should pass elicitedOptions from checkpoint to graph invoke", async () => {
      const elicitedOptions = { instanceType: "t3.micro", az: "us-east-1a" };
      await setCheckpointFile(makeCheckpointJSON({ elicitedOptions }));
      const ctx = makeMockGraphContext();
      const { client } = await createTestClient(ctx);

      await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/options-checkpoint.json",
          confirmed: true,
        },
      });

      const invokeCall = (ctx.graph.invoke as ReturnType<typeof vi.fn>).mock
        .calls[0]!;
      expect(invokeCall[0]).toMatchObject({ elicitedOptions });
    });

    it("should handle non-Error thrown by graph invoke", async () => {
      await setCheckpointFile(makeCheckpointJSON());
      const ctx = makeMockGraphContext();
      (ctx.graph.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(
        "string error value",
      );
      const { client } = await createTestClient(ctx);

      const result = await client.callTool({
        name: "apply_plan",
        arguments: {
          checkpointPath: "/tmp/string-error.json",
          confirmed: true,
        },
      });

      expect(result.isError).toBe(true);
      const body = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      );
      expect(body.message).toContain("string error value");
    });
  });
});
