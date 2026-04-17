import { describe, it, expect, vi } from "vitest";
import { ExecutionStatus, RESOURCE_TYPES } from "../../index.js";
import { MockLlmAdapter } from "../../testing/index.js";
import { createAdviceGeneratorNode } from "./advice-generator.js";
import type { AgentState } from "../graph-state.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an EC2 t3.micro instance for development",
    runId: crypto.randomUUID(),
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "apply",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    desiredState: {
      InstanceType: "t3.micro",
      ImageId: "ami-0c55b159cbfafe1f0",
      MetadataOptions: { HttpTokens: "required" },
    },
    estimatedMonthlyCost: "$8.47/month",
    noAdvice: false,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as AgentState;
}

describe("adviceGeneratorNode", () => {
  it("generates combined rule-based + LLM hints for EC2", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '["Add a CloudWatch CPU alarm for monitoring"]',
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    // Rule-based: IMDSv2 not enforced (no MetadataOptions), t4g suggestion, spot suggestion
    // LLM may also add hints, capped at 5 total
    expect(result.adviceHints!.length).toBeGreaterThan(0);
    expect(result.adviceHints!.length).toBeLessThanOrEqual(5);
    // Should include security hint from rule-based advisor
    expect(result.adviceHints!.some((h) => h.includes("IMDSv2"))).toBe(true);
    // Should include cost hint from rule-based advisor
    expect(result.adviceHints!.some((h) => h.includes("t4g"))).toBe(true);
  });

  it("generates combined hints for S3", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '["Consider enabling versioning"]',
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
        userIntent: "Create an S3 bucket for log storage",
        desiredState: {
          BucketName: "my-logs-bucket",
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
            ],
          },
        },
        estimatedMonthlyCost: "$0.023/GB-month",
      }),
    );

    expect(result.adviceHints!.length).toBeGreaterThan(0);
    // Rule-based: public access block warning, lifecycle suggestion
    expect(
      result.adviceHints!.some((h) => h.includes("Public access block")),
    ).toBe(true);
    expect(result.adviceHints!.some((h) => h.includes("lifecycle"))).toBe(true);
  });

  it("generates combined hints for RDS", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '["Set backup retention to at least 7 days"]',
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
        userIntent: "Create a PostgreSQL database for my app",
        desiredState: {
          DBInstanceClass: "db.r5.large",
          Engine: "postgres",
          EngineVersion: "16.1",
          AllocatedStorage: 20,
        },
        estimatedMonthlyCost: "$131.40/month",
      }),
    );

    expect(result.adviceHints!.length).toBeGreaterThan(0);
    // Rule-based: storage encryption warning, cost alternative (r5 → t3)
    expect(
      result.adviceHints!.some((h) => h.includes("storage encryption")),
    ).toBe(true);
    expect(result.adviceHints!.some((h) => h.includes("db.t3.medium"))).toBe(
      true,
    );
  });

  it("returns rule-based hints even when LLM fails", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      "",
      true,
      "Bedrock InternalServerError",
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    // Rule-based advisors still produce hints even without LLM
    expect(result.adviceHints!.length).toBeGreaterThan(0);
    expect(result.adviceHints!.some((h) => h.includes("IMDSv2"))).toBe(true);
  });

  it("returns rule-based hints when LLM returns malformed response", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      "Here are some tips for your EC2 instance: use t4g instead",
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    // Rule-based advisors still produce hints
    expect(result.adviceHints!.length).toBeGreaterThan(0);
  });

  it("skips LLM call when --no-advice flag is set", async () => {
    const mock = new MockLlmAdapter(undefined, '["Should not appear"]');
    const spy = vi.spyOn(mock, "generateText");
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState({ noAdvice: true }));

    expect(result.adviceHints).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("generates advice for primary resource in compound mode", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '["Consider monitoring VPC flow logs"]',
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.EC2_VPC,
        desiredState: { CidrBlock: "10.0.0.0/16" },
        resourcePattern: { patternId: "vpc-public-only" },
        resourceQueue: [
          { resourceId: "vpc", resourceType: RESOURCE_TYPES.EC2_VPC },
        ],
        currentResourceIndex: 0,
      }),
    );

    // Should have architecture advice + possible LLM hints
    expect(result.adviceHints!.length).toBeGreaterThan(0);
  });

  it("skips advice for companion resource in compound mode", async () => {
    const mock = new MockLlmAdapter(undefined, '["Should not appear"]');
    const spy = vi.spyOn(mock, "generateText");
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourcePattern: { patternId: "vpc-public-only" },
        resourceQueue: [
          { resourceId: "vpc", resourceType: RESOURCE_TYPES.EC2_VPC },
          {
            resourceId: "igw",
            resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
          },
        ],
        currentResourceIndex: 1,
      }),
    );

    expect(result.adviceHints).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns empty array when desiredState is missing", async () => {
    const mock = new MockLlmAdapter(undefined, '["Should not appear"]');
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState({ desiredState: undefined }));

    expect(result.adviceHints).toEqual([]);
  });

  it("caps at 5 hints maximum", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '["Tip 1", "Tip 2", "Tip 3", "Tip 4", "Tip 5", "Tip 6", "Tip 7", "Tip 8"]',
    );
    const node = createAdviceGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.adviceHints).toHaveLength(5);
  });
});
