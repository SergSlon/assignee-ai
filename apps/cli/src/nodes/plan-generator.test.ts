import { describe, it, expect, vi } from "vitest";
import { ExecutionStatus, MockLlmAdapter } from "@assignee/core";
import {
  createPlanGeneratorNode,
  applyToCfnTransforms,
} from "./plan-generator.js";
import type { AgentState } from "../services/graph.js";

// Mock memory service (Story 19.3, 19.4)
vi.mock("../services/memory.js", () => ({
  defaultMemoryService: {
    readProvisions: vi.fn().mockResolvedValue([]),
    readFailures: vi.fn().mockResolvedValue([]),
  },
}));

import { defaultMemoryService } from "../services/memory.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket named my-test-bucket",
    runId: "run-test-123",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: {
      properties: {
        BucketName: { type: "string" },
        Tags: { type: "array" },
        BucketEncryption: { type: "object" },
        PublicAccessBlockConfiguration: { type: "object" },
        VersioningConfiguration: { type: "object" },
        OwnershipControls: { type: "object" },
        LoggingConfiguration: { type: "object" },
      },
      required: ["BucketName"],
    },
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<ReturnType<typeof createPlanGeneratorNode>>[0];
}

describe("planGeneratorNode", () => {
  it("populates desiredState from LLM response", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "my-test-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
    expect(result.executionStatus).toBeUndefined(); // no failure
  });

  it("strips hallucinated fields not in schema", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        BucketName: "test-data-bucket",
        HallucinatedField: "bad",
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "test-data-bucket" });
    expect(
      (result.desiredState as Record<string, unknown>)?.["HallucinatedField"],
    ).toBeUndefined();
  });

  it("returns FAILED when LLM returns invalid JSON", async () => {
    const mock = new MockLlmAdapter(undefined, "not json at all");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("invalid JSON");
  });

  it("returns FAILED when resourceSchema is missing", async () => {
    const mock = new MockLlmAdapter(undefined, "{}");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState({ resourceSchema: undefined }));

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("schema is missing");
  });

  it("skips processing when executionStatus is already FAILED", async () => {
    // mock that would fail if called — ensures no LLM call is made
    const mock = new MockLlmAdapter(
      undefined,
      "",
      true,
      "should not be called",
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );

    expect(result).toEqual({});
  });

  it("handles LLM errors gracefully", async () => {
    const mock = new MockLlmAdapter(undefined, "", true, "ThrottlingException");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("ThrottlingException");
  });

  it("returns FAILED when LLM returns empty text (null-check)", async () => {
    const mock = new MockLlmAdapter(undefined, "");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Plan generation failed");
  });

  it("strips markdown fences from LLM response", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '```json\n{"BucketName":"clean-bucket"}\n```',
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "clean-bucket" });
  });

  it("unwraps CloudFormation Resources section format if LLM generates it", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "my-test-bucket" },
        },
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
  });

  it("includes Lambda runtime constraints and role omission rule in prompt for Lambda resource type", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        FunctionName: "my-fn",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
      }),
    );

    // Spy on generateText to capture the prompt
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(
      makeState({
        resourceType: "AWS::Lambda::Function",
        userIntent: "Create a lambda function",
        resourceSchema: {
          properties: {
            FunctionName: { type: "string" },
            Runtime: { type: "string" },
            Handler: { type: "string" },
            Role: { type: "string" },
          },
          required: ["FunctionName", "Runtime", "Handler", "Role"],
        },
      }),
    );

    expect(capturedPrompt).toContain("nodejs22.x");
    expect(capturedPrompt).toContain("deprecated");
    expect(capturedPrompt).toContain("OMIT the Role property");
  });

  it("does not inject resource hints for non-Lambda resource types", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );

    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(makeState());

    expect(capturedPrompt).not.toContain("RESOURCE-SPECIFIC RULES");
  });

  it("reads schema from uppercase Properties key as fallback", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        BucketName: "test-data-bucket",
        HallucinatedField: "bad",
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourceSchema: {
          Properties: {
            BucketName: { type: "string" },
            Tags: { type: "array" },
          },
          required: ["BucketName"],
        },
      }),
    );

    expect(result.desiredState).toEqual({ BucketName: "test-data-bucket" });
  });
});

// ── Story 19.3: Memory hints from provision history ─────────────────────────

describe("planGeneratorNode — Story 19.3 memory hints", () => {
  it("includes memory hint when previous provision exists for same resource type", async () => {
    vi.mocked(defaultMemoryService.readProvisions).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::old-bucket",
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.50",
        timestamp: new Date().toISOString(),
      },
    ]);

    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    expect(capturedPrompt).toContain("COST CONTEXT");
    expect(capturedPrompt).toContain("$0.50/month");
    expect(result.memoryHints).toBeDefined();
    expect(result.memoryHints).toHaveLength(1);
    expect(result.memoryHints![0]).toContain("$0.50/month");
  });

  it("does not include memory hint when no previous provision exists", async () => {
    vi.mocked(defaultMemoryService.readProvisions).mockResolvedValueOnce([]);

    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    expect(capturedPrompt).not.toContain("COST CONTEXT");
    expect(result.memoryHints).toBeUndefined();
  });

  it("uses most recent provision when multiple exist for same type", async () => {
    vi.mocked(defaultMemoryService.readProvisions).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::old-bucket",
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.50",
        timestamp: new Date(Date.now() - 3600_000).toISOString(),
      },
      {
        runId: "550e8400-e29b-41d4-a716-446655440002",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::newer-bucket",
        region: "us-east-1",
        desiredStateHash: "def456",
        estimatedMonthlyCost: "$1.00",
        timestamp: new Date().toISOString(),
      },
    ]);

    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    // Should use the most recent ($1.00), not the older ($0.50)
    expect(capturedPrompt).toContain("$1.00/month");
    expect(result.memoryHints![0]).toContain("$1.00/month");
  });

  it("gracefully handles memory read failure without affecting plan generation", async () => {
    vi.mocked(defaultMemoryService.readProvisions).mockRejectedValueOnce(
      new Error("Disk error"),
    );

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    // Plan should still generate successfully
    expect(result.desiredState).toEqual({ BucketName: "test-data-bucket" });
    expect(result.memoryHints).toBeUndefined();
  });
});

// ── Story 19.4: Failure history warnings ─────────────────────────────────────

describe("planGeneratorNode — Story 19.4 failure history warnings", () => {
  it("includes warning hint when previous failure exists for same resource type", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::S3::Bucket",
        errorCode: "AlreadyExists",
        errorMessage: "Bucket already exists",
        suggestedFix: "Try a different name.",
        timestamp: new Date().toISOString(),
      },
    ]);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    expect(result.memoryHints).toBeDefined();
    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHint).toBeDefined();
    expect(failureHint).toContain("AWS::S3::Bucket");
    expect(failureHint).toContain("Bucket already exists");
    expect(failureHint).toContain("Fix: Try a different name.");
  });

  it("does not include warning when no previous failure exists", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([]);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    // memoryHints may be undefined (no provision hints either)
    const failureHints = (result.memoryHints ?? []).filter((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHints).toHaveLength(0);
  });

  it("surfaces only the latest failure when multiple exist for same type", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440001",
        resourceType: "AWS::S3::Bucket",
        errorCode: "AlreadyExists",
        errorMessage: "Old error",
        suggestedFix: "Old fix.",
        timestamp: new Date(Date.now() - 3600_000).toISOString(),
      },
      {
        runId: "550e8400-e29b-41d4-a716-446655440002",
        resourceType: "AWS::S3::Bucket",
        errorCode: "Throttled",
        errorMessage: "Recent throttle error",
        suggestedFix: "Wait and retry.",
        timestamp: new Date().toISOString(),
      },
    ]);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHint).toContain("Recent throttle error");
    expect(failureHint).not.toContain("Old error");
  });

  it("omits Fix suffix when suggestedFix is empty", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::S3::Bucket",
        errorCode: "Unknown",
        errorMessage: "Unknown error occurred",
        suggestedFix: "",
        timestamp: new Date().toISOString(),
      },
    ]);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHint).not.toContain("Fix:");
  });

  it("does not include failure warning for different resource type", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::Lambda::Function",
        errorCode: "AlreadyExists",
        errorMessage: "Function already exists",
        suggestedFix: "Try a different name.",
        timestamp: new Date().toISOString(),
      },
    ]);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    // State has resourceType "AWS::S3::Bucket" (default)
    const result = await node(makeState());

    const failureHints = (result.memoryHints ?? []).filter((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHints).toHaveLength(0);
  });

  it("gracefully handles failure read error without affecting plan generation", async () => {
    vi.mocked(defaultMemoryService.readFailures).mockRejectedValueOnce(
      new Error("Disk error"),
    );

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    // Plan should still generate successfully
    expect(result.desiredState).toEqual({ BucketName: "test-data-bucket" });
  });

  it("suppresses failure hint when latest success is newer than latest failure (Story 20.13)", async () => {
    const provisionData = [
      {
        runId: "550e8400-e29b-41d4-a716-446655440001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::my-bucket",
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.50/mo",
        timestamp: new Date().toISOString(),
      },
    ];
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::S3::Bucket",
        errorCode: "AlreadyExists",
        errorMessage: "Bucket already exists",
        suggestedFix: "Try a different name.",
        timestamp: new Date(Date.now() - 3600_000).toISOString(),
      },
    ]);
    // First call: cost-hint section; second call: failure-check section
    vi.mocked(defaultMemoryService.readProvisions)
      .mockResolvedValueOnce(provisionData)
      .mockResolvedValueOnce(provisionData);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    const failureHints = (result.memoryHints ?? []).filter((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHints).toHaveLength(0);
  });

  it("shows failure hint when failure is newer than latest success (Story 20.13)", async () => {
    const provisionData = [
      {
        runId: "550e8400-e29b-41d4-a716-446655440001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::my-bucket",
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.50/mo",
        timestamp: new Date(Date.now() - 7200_000).toISOString(),
      },
    ];
    vi.mocked(defaultMemoryService.readFailures).mockResolvedValueOnce([
      {
        runId: "550e8400-e29b-41d4-a716-446655440000",
        resourceType: "AWS::S3::Bucket",
        errorCode: "AlreadyExists",
        errorMessage: "Bucket already exists",
        suggestedFix: "Try a different name.",
        timestamp: new Date().toISOString(),
      },
    ]);
    // First call: cost-hint section; second call: failure-check section
    vi.mocked(defaultMemoryService.readProvisions)
      .mockResolvedValueOnce(provisionData)
      .mockResolvedValueOnce(provisionData);

    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(makeState());

    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    );
    expect(failureHint).toBeDefined();
    expect(failureHint).toContain("Bucket already exists");
  });
});

// ── Story 18.9: toCfn transform tests ────────────────────────────────────────

describe("applyToCfnTransforms", () => {
  it("transforms S3 boolean options into CFN structures", () => {
    const result = applyToCfnTransforms(
      {
        BucketEncryption: true,
        PublicAccessBlockConfiguration: true,
        VersioningConfiguration: true,
      },
      "AWS::S3::Bucket",
    );

    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
    expect(result["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(result["VersioningConfiguration"]).toEqual({ Status: "Enabled" });
  });

  it("omits fields where toCfn returns undefined (user said no)", () => {
    const result = applyToCfnTransforms(
      {
        BucketEncryption: false,
        PublicAccessBlockConfiguration: false,
        VersioningConfiguration: false,
      },
      "AWS::S3::Bucket",
    );

    expect(result["BucketEncryption"]).toBeUndefined();
    expect(result["PublicAccessBlockConfiguration"]).toBeUndefined();
    expect(result["VersioningConfiguration"]).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("passes through fields without toCfn unchanged", () => {
    const result = applyToCfnTransforms(
      { BucketName: "test-data-bucket", BucketEncryption: true },
      "AWS::S3::Bucket",
    );

    expect(result["BucketName"]).toBe("test-data-bucket");
    expect(result["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
  });

  it("returns options unchanged when plugin is not found", () => {
    const options = { SomeField: "some-value" };
    const result = applyToCfnTransforms(options, "AWS::Unknown::Resource");

    expect(result).toEqual(options);
  });

  it("transforms advanced fields (Lifecycle, CORS sub-fields → CFN structures)", () => {
    const result = applyToCfnTransforms(
      {
        EnableLifecycle: true,
        LifecycleTransitionDays: "30",
        EnableCors: true,
        CorsAllowedOrigins: "*",
        CorsAllowedMethods: "GET",
      },
      "AWS::S3::Bucket",
    );

    expect(result["LifecycleConfiguration"]).toEqual({
      Rules: [
        {
          Id: "assignee-default-lifecycle",
          Status: "Enabled",
          Transitions: [{ StorageClass: "STANDARD_IA", TransitionInDays: 30 }],
        },
      ],
    });
    expect(result["CorsConfiguration"]).toEqual({
      CorsRules: [{ AllowedHeaders: ["*"], AllowedMethods: ["GET"], AllowedOrigins: ["*"] }],
    });
    // Intermediate keys must be removed
    expect(result["EnableLifecycle"]).toBeUndefined();
    expect(result["EnableCors"]).toBeUndefined();
    expect(result["LifecycleTransitionDays"]).toBeUndefined();
    expect(result["CorsAllowedOrigins"]).toBeUndefined();
    expect(result["CorsAllowedMethods"]).toBeUndefined();
  });
});

describe("planGeneratorNode — Story 18.9 toCfn integration", () => {
  it("applies toCfn transforms to elicited options in standard mode", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        elicitedOptions: {
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
    expect(ds["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it("omits false-valued toCfn fields from desiredState", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "test-data-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        elicitedOptions: {
          BucketEncryption: false,
          VersioningConfiguration: false,
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["BucketEncryption"]).toBeUndefined();
    expect(ds["VersioningConfiguration"]).toBeUndefined();
    expect(ds["BucketName"]).toBe("test-data-bucket");
  });

  it("applies toCfn transforms in compound mode", async () => {
    const mock = new MockLlmAdapter(undefined, "unused");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        executionStatus: ExecutionStatus.PENDING,
        resourcePattern: {
          patternId: "static-website",
          description: "Static website",
          resourceIds: ["bucket"],
          defaultOptions: {
            bucket: { BucketName: "site-bucket" },
          },
        },
        resourceQueue: [
          { resourceId: "bucket", resourceType: "AWS::S3::Bucket" },
        ],
        currentResourceIndex: 0,
        elicitedOptions: {
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
        },
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["BucketEncryption"]).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
      ],
    });
    expect(ds["PublicAccessBlockConfiguration"]).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(ds["BucketName"]).toBe("site-bucket");
  });
});
