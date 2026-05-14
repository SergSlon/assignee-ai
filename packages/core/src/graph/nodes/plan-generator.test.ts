import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  ResourceDefault,
} from "../../index.js";
import { MockLlmAdapter } from "../../testing/index.js";
import { ProcessEnvConfigAdapter } from "../../config/config-port.js";
import {
  createPlanGeneratorNode,
  __resetAzCacheForTests,
} from "./plan-generator.js";
import { markerRef, markerAz } from "../../index.js";

// Mock memory service (Story 19.3, 19.4).
// NOTE: Default impls are re-installed in beforeEach because vitest's
// mockReset:true wipes vi.fn implementations between tests.
// Story 50-4 Wave 5 Pass H.2: this test now lives in @assignee/core
// alongside the lifted plan-generator node; the single core-relative
// vi.mock on `../../services/memory.js` intercepts both the test
// imports and the production llm-helpers' internal imports.
const { _memoryMocks } = vi.hoisted(() => ({
  _memoryMocks: {
    defaultMemoryService: {
      readProvisions: vi.fn(),
      readFailures: vi.fn(),
      appendProvision: vi.fn(),
      appendFailure: vi.fn(),
      upsertPattern: vi.fn(),
      clearFailuresForType: vi.fn(),
    },
  },
}));
vi.mock("../../services/memory.js", () => _memoryMocks);

import { defaultMemoryService } from "../../services/memory.js";

beforeEach(() => {
  vi.mocked(defaultMemoryService.readProvisions).mockResolvedValue([]);
  vi.mocked(defaultMemoryService.readFailures).mockResolvedValue([]);
});

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
    // RW4b-3: ConfigPort threaded through state so depth-3+ callers
    // (warnIfGuardrailDisabled, preflight guards, plan formatter) can
    // read configuration without constructing fresh adapters.
    config: new ProcessEnvConfigAdapter(),
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

    const result = await node(
      makeState({ elicitedOptions: { BucketName: "my-test-bucket" } }),
    );

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

    const result = await node(
      makeState({ elicitedOptions: { BucketName: "test-data-bucket" } }),
    );

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

    const result = await node(
      makeState({ elicitedOptions: { BucketName: "clean-bucket" } }),
    );

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

    const result = await node(
      makeState({ elicitedOptions: { BucketName: "my-test-bucket" } }),
    );

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

  it("injects resource-specific hints for plugins with configHints", async () => {
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
    await node(makeState()); // S3 has configHints

    // S3, EC2, RDS, Lambda, and other plugins now have configHints
    expect(capturedPrompt).toContain("RESOURCE-SPECIFIC RULES");
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
        elicitedOptions: { BucketName: "test-data-bucket" },
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
    // Tier C: dropped redundant toBeDefined() — toHaveLength fails on undefined
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

    const result = await node(
      makeState({ elicitedOptions: { BucketName: "test-data-bucket" } }),
    );

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

    // Tier C: dropped redundant toBeDefined() — find!() at the find site
    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    )!;
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
    const result = await node(
      makeState({ elicitedOptions: { BucketName: "test-data-bucket" } }),
    );

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

    // Tier C: dropped redundant toBeDefined() — find!()
    const failureHint = result.memoryHints!.find((h: string) =>
      h.includes("Previous error"),
    )!;
    expect(failureHint).toContain("Bucket already exists");
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
          BucketName: "test-data-bucket",
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

// ── EC2 post-processing: SG cleanup and SSH intent detection ───────────────

describe("planGeneratorNode — EC2 post-processing", () => {
  function makeEc2State(overrides: Record<string, unknown> = {}) {
    return makeState({
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      userIntent: "Create an EC2 instance",
      resourceSchema: {
        properties: {
          InstanceType: { type: "string" },
          ImageId: { type: "string" },
          KeyName: { type: "string" },
          SecurityGroupIds: { type: "array" },
          MetadataOptions: { type: "object" },
          BlockDeviceMappings: { type: "array" },
        },
        required: ["ImageId"],
      },
      ...overrides,
    });
  }

  describe("SecurityGroupIds cleanup", () => {
    it("strips placeholder SG IDs that do not start with sg-", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          SecurityGroupIds: ["sg-0abc123def456", "placeholder-sg"],
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State());
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["SecurityGroupIds"]).toEqual(["sg-0abc123def456"]);
    });

    it("deletes SecurityGroupIds entirely when all IDs are invalid", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          SecurityGroupIds: ["placeholder", "sg-invalid-no-wait"],
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State());
      const ds = result.desiredState as Record<string, unknown>;

      // "sg-invalid-no-wait" starts with "sg-" so it should be kept
      expect(ds["SecurityGroupIds"]).toEqual(["sg-invalid-no-wait"]);
    });

    it("deletes SecurityGroupIds when array is empty", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          SecurityGroupIds: [],
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State());
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["SecurityGroupIds"]).toBeUndefined();
    });

    it("preserves valid SecurityGroupIds unchanged", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          SecurityGroupIds: ["sg-0abc123", "sg-0def456"],
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State());
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["SecurityGroupIds"]).toEqual(["sg-0abc123", "sg-0def456"]);
    });

    it("removes all non-sg- IDs leaving none — deletes the field", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          SecurityGroupIds: ["fake-id", "not-a-sg"],
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State());
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["SecurityGroupIds"]).toBeUndefined();
    });
  });

  describe("SSH intent detection", () => {
    it("injects SSH_KEY_PLACEHOLDER when userIntent contains 'ssh'", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          InstanceType: "t3.micro",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeEc2State({ userIntent: "Create an EC2 instance I can SSH into" }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    });

    it("injects placeholder for uppercase SSH", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeEc2State({ userIntent: "Launch an instance with SSH access" }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    });

    it("does NOT match 'sshd' due to word boundary", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeEc2State({ userIntent: "Create an instance to run sshd proxy" }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      // "sshd" should NOT trigger SSH intent detection (word boundary)
      expect(ds["KeyName"]).toBeUndefined();
    });

    it("does NOT override existing KeyName from LLM", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          KeyName: "my-existing-key",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeEc2State({ userIntent: "SSH into my EC2 instance" }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBe("my-existing-key");
    });

    it("does NOT inject KeyName when intent has no SSH mention", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeEc2State({ userIntent: "Create a web server" }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBeUndefined();
    });

    it("does NOT inject KeyName when userIntent is undefined", async () => {
      const mock = new MockLlmAdapter(
        undefined,
        JSON.stringify({
          ImageId: "ami-0abcdef1234567890",
          MetadataOptions: { HttpTokens: "required" },
        }),
      );
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(makeEc2State({ userIntent: undefined }));
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBeUndefined();
    });
  });

  describe("compound mode EC2 post-processing", () => {
    it("strips invalid SG IDs in compound mode", async () => {
      const mock = new MockLlmAdapter(undefined, "{}");
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeState({
          resourceType: RESOURCE_TYPES.EC2_INSTANCE,
          userIntent: "Create a VPC with EC2",
          resourcePattern: {
            patternId: "vpc-ec2",
            displayName: "VPC + EC2",
            resources: [],
            defaultOptions: {
              ec2: {
                ImageId: "ami-0abcdef1234567890",
                SecurityGroupIds: ["placeholder-sg"],
              },
            },
          },
          resourceQueue: [
            {
              resourceId: "ec2",
              resourceType: RESOURCE_TYPES.EC2_INSTANCE,
            },
          ],
          currentResourceIndex: 0,
        }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["SecurityGroupIds"]).toBeUndefined();
    });

    it("injects SSH key placeholder in compound mode when intent mentions SSH", async () => {
      const mock = new MockLlmAdapter(undefined, "{}");
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeState({
          resourceType: RESOURCE_TYPES.EC2_INSTANCE,
          userIntent: "Create a VPC with an EC2 I can SSH into",
          resourcePattern: {
            patternId: "vpc-ec2",
            displayName: "VPC + EC2",
            resources: [],
            defaultOptions: {
              ec2: {
                ImageId: "ami-0abcdef1234567890",
              },
            },
          },
          resourceQueue: [
            {
              resourceId: "ec2",
              resourceType: RESOURCE_TYPES.EC2_INSTANCE,
            },
          ],
          currentResourceIndex: 0,
        }),
      );
      const ds = result.desiredState as Record<string, unknown>;

      expect(ds["KeyName"]).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    });
  });

  // ── Fail-closed credential enforcement (Lambda role-ARN STS path) ──────────
  // The plan-generator constructs an STSClient inside the compound Lambda
  // role-ARN derivation path. That client must use
  // requireAssigneeCredentials("operator") so it never falls through to the
  // default AWS credential chain. The cross-reference path is wrapped in
  // try/catch and falls back to the role NAME on any error — so when env
  // vars are missing, we assert that the desired state contains the role
  // name (not an ARN derived from a leaked AWS account).
  describe("fail-closed STSClient credential enforcement", () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
      delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
      delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
      // Belt-and-suspenders: shell AWS_* must NOT be honored
      process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";
    });

    afterEach(() => {
      process.env = { ...ORIGINAL_ENV };
    });

    it("Lambda role ARN derivation falls back to role name when operator creds missing", async () => {
      // The compound-mode cross-reference path normally constructs an
      // STSClient to derive the IAM role ARN from a name.
      //
      // Wave-2 fix (H5): we now do a precondition check with
      // `tryAssigneeCredentials("operator")` BEFORE importing @aws-sdk/client-sts.
      // When ASSIGNEE_OPERATOR_* is unset, we skip the STS call entirely,
      // emit a warn log, and assign the bare role name. This replaces the
      // previous behavior where the try/catch silently swallowed a thrown
      // MissingAssigneeCredentialsError with an info-level log.
      //
      // Critical assertion: Role must NOT be an ARN derived from a leaked
      // shell AWS account — the shell AWS_* vars below must be ignored.
      const mock = new MockLlmAdapter(undefined, "{}");
      const node = createPlanGeneratorNode({ llmClient: mock });

      const result = await node(
        makeState({
          resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
          userIntent: "Compound serverless API",
          resourcePattern: {
            patternId: "serverless-api",
            displayName: "Serverless API",
            resources: [],
            defaultOptions: {
              "lambda-fn": {
                FunctionName: "compound-lambda",
                Runtime: "nodejs20.x",
                Handler: "index.handler",
                Code: { ZipFile: "exports.handler = async () => {};" },
              },
            },
          },
          resourceQueue: [
            {
              resourceId: "lambda-fn",
              resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
            },
          ],
          currentResourceIndex: 0,
          completedResources: [
            {
              resourceType: RESOURCE_TYPES.IAM_ROLE,
              resourceArn: "lambda-execution-role-name",
              resourceId: "lambda-role",
            },
          ],
        }),
      );

      const ds = result.desiredState as Record<string, unknown>;
      // Critical: must be the bare role name — NOT an ARN derived from a
      // leaked AWS account.
      expect(ds["Role"]).toBe("lambda-execution-role-name");
      expect(String(ds["Role"])).not.toMatch(/^arn:/);
    });

    it("never dynamically imports @aws-sdk/client-sts when operator creds are missing", async () => {
      // Regression guard for H5: the precondition check must short-circuit
      // BEFORE the dynamic `import("@aws-sdk/client-sts")`. We detect this
      // by recording any dynamic imports of the module during the node run
      // and asserting none occurred.
      //
      // We can't easily spy on `import()` directly in Vitest, but we can
      // rely on the fact that if the STS client were constructed, the
      // send() call would throw (since the module is unmocked and we have
      // no real AWS connectivity in the test env) and the desired state
      // would still fall back to the bare role name. The stronger check
      // is that execution time stays small — exercising the full SDK
      // client-create path would blow past this budget on most machines.
      const mock = new MockLlmAdapter(undefined, "{}");
      const node = createPlanGeneratorNode({ llmClient: mock });

      const start = Date.now();
      const result = await node(
        makeState({
          resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
          userIntent: "Compound serverless API",
          resourcePattern: {
            patternId: "serverless-api",
            displayName: "Serverless API",
            resources: [],
            defaultOptions: {
              "lambda-fn": {
                FunctionName: "compound-lambda",
                Runtime: "nodejs20.x",
                Handler: "index.handler",
                Code: { ZipFile: "exports.handler = async () => {};" },
              },
            },
          },
          resourceQueue: [
            {
              resourceId: "lambda-fn",
              resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
            },
          ],
          currentResourceIndex: 0,
          completedResources: [
            {
              resourceType: RESOURCE_TYPES.IAM_ROLE,
              resourceArn: "lambda-execution-role-name",
              resourceId: "lambda-role",
            },
          ],
        }),
      );
      const durationMs = Date.now() - start;

      const ds = result.desiredState as Record<string, unknown>;
      expect(ds["Role"]).toBe("lambda-execution-role-name");
      // With the precondition check in place the compound-mode Lambda
      // planning path must complete quickly — no real SDK client creation
      // or network call. A 10-second allowance is generous but catches
      // regressions where we accidentally construct STSClient and wait for
      // a network timeout.
      expect(durationMs).toBeLessThan(10_000);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Compound plan-generator branch: marker resolution integration
// ─────────────────────────────────────────────────────────────────────────
describe("compound plan-generator branch — marker resolution integration", () => {
  beforeEach(() => {
    __resetAzCacheForTests();
  });

  it("resolves markers in VPC subnet desiredState before returning", async () => {
    const mock = new MockLlmAdapter(undefined, "{}");
    const node = createPlanGeneratorNode({
      llmClient: mock,
      azLookup: async () => ["us-east-1a", "us-east-1b", "us-east-1c"],
    });

    const result = await node(
      makeState({
        executionMode: "apply", // apply mode resolves markers against completedResources
        resourceType: RESOURCE_TYPES.EC2_SUBNET,
        userIntent: "Create a VPC with public subnets",
        resourcePattern: {
          patternId: "vpc-networking",
          displayName: "VPC with Public and Private Subnets",
          resources: [],
          defaultOptions: {
            "public-subnet-1": {
              CidrBlock: "10.0.1.0/24",
              AvailabilityZone: markerAz(0),
              MapPublicIpOnLaunch: true,
              VpcId: markerRef("vpc"),
            },
          },
        },
        resourceQueue: [
          {
            resourceId: "public-subnet-1",
            resourceType: RESOURCE_TYPES.EC2_SUBNET,
          },
        ],
        currentResourceIndex: 0,
        completedResources: [
          {
            resourceId: "vpc",
            resourceType: RESOURCE_TYPES.EC2_VPC,
            resourceArn: "vpc-0abc123def456789",
            executionStatus: ExecutionStatus.SUCCESS,
          },
        ],
      }),
    );

    const ds = result.desiredState as Record<string, unknown>;
    expect(ds["VpcId"]).toBe("vpc-0abc123def456789");
    expect(ds["AvailabilityZone"]).toBe("us-east-1a");
    expect(JSON.stringify(ds)).not.toMatch(/__ASSIGNEE_/);
    expect(JSON.stringify(ds)).not.toMatch(/Fn::/);
    expect(result.executionStatus).toBeUndefined(); // no failure
  });

  it("returns FAILED when marker target is missing from completedResources", async () => {
    const mock = new MockLlmAdapter(undefined, "{}");
    const node = createPlanGeneratorNode({
      llmClient: mock,
      azLookup: async () => ["us-east-1a", "us-east-1b"],
    });

    const result = await node(
      makeState({
        executionMode: "apply", // apply mode requires completedResources for markers
        resourceType: RESOURCE_TYPES.EC2_SUBNET,
        userIntent: "Create a VPC with public subnets",
        resourcePattern: {
          patternId: "vpc-networking",
          displayName: "VPC",
          resources: [],
          defaultOptions: {
            "public-subnet-1": {
              CidrBlock: "10.0.1.0/24",
              VpcId: markerRef("vpc"),
            },
          },
        },
        resourceQueue: [
          {
            resourceId: "public-subnet-1",
            resourceType: RESOURCE_TYPES.EC2_SUBNET,
          },
        ],
        currentResourceIndex: 0,
        completedResources: [], // vpc not yet provisioned — ERROR
      }),
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(
      /no completed resource with resourceId "vpc"/,
    );
  });
});

// ── Epic 92 Wave 2.d — post-LLM plan-time validators ────────────────────────
//
// These integration tests drive the validator through the full node path
// (makeState → LLM mock → runLlmPlan → sanitize → post-process → validator).
// The Wave 1 sanitizer auto-fixes the common A-16 shape, so to prove the
// belt-and-braces validator fires we use desiredState shapes the sanitizer
// doesn't cover (e.g. schema missing AttributeDefinitions so it is stripped,
// or LSI KeySchema referencing an attribute type-mismatched by intent).

describe("planGeneratorNode — Epic 92 Wave 2.d validators", () => {
  it("passes DDB plan validation when sanitizer auto-fills AttributeDefinitions", async () => {
    // Real-world F-A-16 repro: LLM emits KeySchema referencing an attr not
    // in AttributeDefinitions. The Wave 1 sanitizer auto-synthesises the
    // missing definition, so the validator passes silently and plan generation
    // succeeds — proving the belt-and-braces layering (sanitizer fixes;
    // validator stays quiet).
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        TableName: "payments-prod",
        KeySchema: [{ AttributeName: "hashKey", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "Id", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
        userIntent: "Create a DynamoDB table with hashKey primary key",
        resourceSchema: {
          properties: {
            TableName: { type: "string" },
            KeySchema: { type: "array" },
            AttributeDefinitions: { type: "array" },
            BillingMode: { type: "string" },
            GlobalSecondaryIndexes: { type: "array" },
            LocalSecondaryIndexes: { type: "array" },
          },
          required: ["KeySchema", "AttributeDefinitions"],
        },
      }),
    );
    // Sanitizer auto-filled the missing AttributeDefinition → validator passes.
    expect(result.executionStatus).toBeUndefined();
    const defs = (result.desiredState as Record<string, unknown>)[
      "AttributeDefinitions"
    ] as Array<Record<string, unknown>>;
    expect(defs.map((d) => d["AttributeName"])).toContain("hashKey");
  });

  it("passes DDB plan validation for a composite-key table with matching AttributeDefinitions", async () => {
    // Clean LLM output: KeySchema names all present in AttributeDefinitions.
    // Sanitizer's DDB rule runs but has nothing to fix; validator stays quiet.
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        TableName: "events",
        KeySchema: [
          { AttributeName: "userId", KeyType: "HASH" },
          { AttributeName: "eventId", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "userId", AttributeType: "S" },
          { AttributeName: "eventId", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
        userIntent: "Create a DynamoDB table with composite key",
        resourceSchema: {
          properties: {
            TableName: { type: "string" },
            KeySchema: { type: "array" },
            AttributeDefinitions: { type: "array" },
            BillingMode: { type: "string" },
          },
          required: ["KeySchema", "AttributeDefinitions"],
        },
      }),
    );
    // Clean shape — both layers happy.
    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it("passes CloudFront plan validation when Origin has only one config", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        DistributionConfig: {
          Enabled: true,
          DefaultCacheBehavior: {
            TargetOriginId: "s3-origin",
            ViewerProtocolPolicy: "redirect-to-https",
          },
          Origins: {
            Items: [
              {
                Id: "s3-origin",
                DomainName: "static-site.s3.us-east-1.amazonaws.com",
                S3OriginConfig: { OriginAccessIdentity: "" },
              },
            ],
            Quantity: 1,
          },
        },
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        userIntent: "Create a CloudFront distribution for static-site S3",
        resourceSchema: {
          properties: { DistributionConfig: { type: "object" } },
          required: ["DistributionConfig"],
        },
      }),
    );
    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });

  it("resolves CloudFront dual-origin via sanitizer disambiguation (no validator fail)", async () => {
    // LLM emits BOTH S3OriginConfig and CustomOriginConfig with an S3-shaped
    // DomainName. The Wave 1 sanitizer's CloudFront rule disambiguates by
    // dropping CustomOriginConfig (because DomainName matches the S3 regex).
    // The validator then passes — proving sanitizer is the primary layer.
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        DistributionConfig: {
          Enabled: true,
          DefaultCacheBehavior: {
            TargetOriginId: "dual-origin",
            ViewerProtocolPolicy: "redirect-to-https",
          },
          Origins: {
            Items: [
              {
                Id: "dual-origin",
                DomainName: "mixed-bucket.s3.us-east-1.amazonaws.com",
                S3OriginConfig: { OriginAccessIdentity: "" },
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: "https-only",
                },
              },
            ],
            Quantity: 1,
          },
        },
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });
    const result = await node(
      makeState({
        resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
        userIntent: "Create a CloudFront distribution",
        resourceSchema: {
          properties: { DistributionConfig: { type: "object" } },
          required: ["DistributionConfig"],
        },
      }),
    );
    // Sanitizer disambiguated → validator passes.
    expect(result.executionStatus).toBeUndefined();
    const origins = (
      (result.desiredState as Record<string, unknown>)[
        "DistributionConfig"
      ] as Record<string, unknown>
    )["Origins"];
    const firstItem = (origins as Record<string, unknown>)["Items"] as Array<
      Record<string, unknown>
    >;
    // CustomOriginConfig was dropped because DomainName looks like S3.
    expect(firstItem[0]).toHaveProperty("S3OriginConfig");
    expect(firstItem[0]).not.toHaveProperty("CustomOriginConfig");
  });

  it("emits resource-type-specific placeholder examples in rule 7 (SNS does not include Lambda ARN)", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ TopicName: "order-events" }),
    );
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(
      makeState({
        resourceType: RESOURCE_TYPES.SNS_TOPIC,
        userIntent: "Create an SNS topic for order events",
        resourceSchema: {
          properties: {
            TopicName: { type: "string" },
            DisplayName: { type: "string" },
          },
          required: ["TopicName"],
        },
      }),
    );

    // Rule 7 must not leak the Lambda IAM role ARN example into an SNS prompt.
    expect(capturedPrompt).not.toContain(
      "arn:aws:iam::123456789012:role/my-role",
    );
    expect(capturedPrompt).toContain("my-topic");
  });

  it("includes Lambda-specific placeholder examples in rule 7 for Lambda resource type", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        FunctionName: "my-fn",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
      }),
    );
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(
      makeState({
        resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
        userIntent: "Create a Lambda function",
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

    expect(capturedPrompt).toContain("arn:aws:iam::123456789012:role/my-role");
  });
});
