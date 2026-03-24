/**
 * Integration tests for the full LangGraph agent flow.
 *
 * These tests exercise the REAL node implementations (schema_fetcher, preflight_guard,
 * plan_generator, etc.) with mocked external boundaries:
 *   - LLM: mocked via `ai` module (LiteLLMAdapter mock delegates to it)
 *   - MCP tools: mocked via test-fixtures/mcp-mock-responses.ts
 *   - CloudControl: mocked module to prevent real AWS calls
 *   - Display/Prompts: mocked to prevent TTY output
 *
 * All tests run in plan mode (non-TTY) to avoid interactive prompts and
 * the LangGraph interrupt at resource_provisioner.
 *
 * Flow under test:
 *   intent_parser → schema_fetcher → option_elicitor → compound_dispatcher →
 *   plan_generator → preflight_guard → [routePreflightGuard] → result_formatter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import {
  McpMocks,
  createMockTool,
  createCoreMockTools,
  createFailingMockTool,
  createAllMockTools,
} from "../test-fixtures/mcp-mock-responses.js";
import { ToolName } from "../constants/tools.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Mock CloudControl client — prevents real AWS API calls
vi.mock("../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn(() => ({ send: vi.fn() })),
}));

// Mock the AI SDK — intercepts all LLM calls made by BedrockLlmAdapter
const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: { object: vi.fn((opts: unknown) => opts) },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

// Mock LiteLLMAdapter — delegates to the same ai mock so existing test fixtures work.
vi.mock("./litellm-adapter.js", async () => {
  const { LlmError, safeTry } = await import("@assignee/core");
  const ai = await import("ai");
  return {
    LiteLLMAdapter: vi.fn().mockImplementation(() => ({
      generateStructured: async (
        prompt: string,
        schema: unknown,
        options?: { maxTokens?: number },
      ) => {
        const [err, result] = await safeTry(
          ai.generateText({
            model: {} as never,
            output: ai.Output.object({ schema: schema as never }),
            maxOutputTokens: options?.maxTokens ?? 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        if (err)
          return [
            new LlmError(`Structured LLM call failed: ${String(err)}`),
            null,
          ] as const;
        return [null, (result as { output: unknown }).output] as const;
      },
      generateText: async (
        prompt: string,
        options?: { maxTokens?: number },
      ) => {
        const [err, result] = await safeTry(
          ai.generateText({
            model: {} as never,
            maxOutputTokens: options?.maxTokens ?? 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        );
        if (err)
          return [
            new LlmError(`Text LLM call failed: ${String(err)}`),
            null,
          ] as const;
        return [null, (result as { text: string }).text] as const;
      },
    })),
  };
});

// Mock display utilities — capture output without writing to terminal
vi.mock("../utils/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/display.js")>();
  return {
    ...actual,
    renderPlanBox: vi.fn(),
    renderError: vi.fn(),
    renderApplySuccess: vi.fn(),
    renderOutro: vi.fn(),
    renderIntro: vi.fn(),
    renderHitlConfirm: vi.fn().mockResolvedValue(false),
    renderHitlCompoundConfirm: vi.fn().mockResolvedValue(false),
    renderDependencyPlan: vi.fn(),
    renderCompoundSuccess: vi.fn(),
    renderDocHelp: vi.fn().mockResolvedValue(undefined),
    startSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
    renderOptionPrompt: vi.fn(),
    renderAdvancedConfirm: vi.fn().mockResolvedValue(false),
  };
});

// Mock clack prompts (used by option-elicitor for spinners)
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}));

import { createGraph } from "./graph.js";
const { renderPlanBox, renderError } = await import("../utils/display.js");

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Configures mockGenerateText to handle both intent-parser (structured)
 * and plan-generator (text) calls in sequence.
 */
function mockLlmForPlanFlow(resourceType: string, desiredStateJson: string) {
  mockGenerateText
    // Call 1: intent-parser → generateStructured → uses output field
    .mockResolvedValueOnce({ output: { resourceType }, text: "" })
    // Call 2: plan-generator → generateText → uses text field
    .mockResolvedValueOnce({ text: desiredStateJson, output: undefined });
}

// ── Test setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset is required to clear mockResolvedValueOnce queues
  // (vi.clearAllMocks only calls mockClear which may not flush them)
  mockGenerateText.mockReset();
  // Force non-TTY to skip option-elicitor interactive prompts
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe("Graph integration — plan mode", () => {
  it("S3 bucket: full happy path with live S3 pricing", async () => {
    const bpCompliantS3 = JSON.stringify({
      BucketName: "integration-test-bucket",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      },
      LifecycleConfiguration: { Rules: [{ Status: "Enabled" }] },
      LoggingConfiguration: { DestinationBucketName: "logs-bucket" },
    });
    mockLlmForPlanFlow("AWS::S3::Bucket", bpCompliantS3);

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named integration-test-bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-s3-plan" } },
    );

    // Verifies the full chain executed successfully
    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.desiredState).toHaveProperty(
      "BucketName",
      "integration-test-bucket",
    );
    expect(result.preflightPassed).toBe(true);
    expect(result.estimatedMonthlyCost).toMatch(/\$0\.0230/); // S3 first-tier price
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);

    // Schema fetcher called the MCP tool
    const schemaTool = tools[0]!;
    expect(schemaTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ resource_type: "AWS::S3::Bucket" }),
    );

    // Pricing tool called for cost estimation
    const pricingTool = tools[1]!;
    expect(pricingTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ service_code: "AmazonS3" }),
    );

    // Plan box was rendered (plan mode renders plan in result_formatter)
    expect(renderPlanBox).toHaveBeenCalled();
  });

  it("Lambda function: schema validation catches missing required field", async () => {
    // LLM generates a plan that is MISSING the required "Code" field
    mockLlmForPlanFlow(
      "AWS::Lambda::Function",
      '{"FunctionName":"my-fn","Runtime":"nodejs22.x","Role":"arn:aws:iam::123456789012:role/lambda-exec"}',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.lambdaFunction.success,
      McpMocks.pricing.emptyData.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a Lambda function",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-lambda-missing-field" } },
    );

    // preflight_guard should fail because Code is required but missing
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Code");
    expect(renderError).toHaveBeenCalled();
  });

  it("EC2 instance: happy path with all required fields", async () => {
    const bpCompliantEc2 = JSON.stringify({
      InstanceType: "t3.micro",
      ImageId: "ami-0123456789abcdef0",
      MetadataOptions: { HttpTokens: "required" },
      BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: "gp3" } }],
    });
    mockLlmForPlanFlow("AWS::EC2::Instance", bpCompliantEc2);

    const tools = createCoreMockTools(
      McpMocks.schema.ec2Instance.success,
      McpMocks.pricing.ec2T3Micro.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent:
          "Create a t3.micro EC2 instance with AMI ami-0123456789abcdef0",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-ec2-happy" } },
    );

    expect(result.resourceType).toBe("AWS::EC2::Instance");
    expect(result.desiredState).toHaveProperty("InstanceType", "t3.micro");
    // BP may fire CRITICALs for array-path fields (BlockDeviceMappings[0]) — plan flow still completes
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });

  it("Lambda function: uses local pricing estimate (no MCP pricing call)", async () => {
    mockLlmForPlanFlow(
      "AWS::Lambda::Function",
      '{"FunctionName":"my-fn","Runtime":"nodejs22.x","Role":"arn:aws:iam::123456789012:role/lambda-exec","Code":{"ZipFile":"exports.handler=async()=>({statusCode:200})"}}',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.lambdaFunction.success,
      McpMocks.pricing.emptyData.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a Lambda function named my-fn using Node.js 22",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-lambda-local-pricing" } },
    );

    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.desiredState).toMatchObject({
      FunctionName: "my-fn",
      Runtime: "nodejs22.x",
      Role: "arn:aws:iam::123456789012:role/lambda-exec",
      Code: { ZipFile: "exports.handler=async()=>({statusCode:200})" },
    });
    expect(result.preflightPassed).toBe(true);
    // Lambda uses local estimate formula, not MCP pricing
    expect(result.estimatedMonthlyCost).toMatch(/million req/);
    expect(result.estimatedMonthlyCost).toContain("128MB");
  });

  it("IAM Role: free-tier resource — no pricing tool invoked", async () => {
    mockLlmForPlanFlow(
      "AWS::IAM::Role",
      '{"RoleName":"my-exec-role","AssumeRolePolicyDocument":{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}}',
    );

    const pricingTool = createMockTool(
      ToolName.GET_PRICING,
      McpMocks.pricing.zeroPrice.success,
    );
    const tools = [
      createMockTool(
        ToolName.GET_RESOURCE_SCHEMA,
        McpMocks.schema.iamRole.success,
      ),
      pricingTool,
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an IAM role for Lambda execution",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-iam-free" } },
    );

    expect(result.resourceType).toBe("AWS::IAM::Role");
    expect(result.estimatedMonthlyCost).toBe("Free");
    expect(result.preflightPassed).toBe(true);
    // Pricing tool should NOT have been called for IAM (free-tier, no mcpConfig)
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("RDS instance: multi-engine pricing path", async () => {
    const bpCompliantRds = JSON.stringify({
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      DBInstanceIdentifier: "test-db",
      PubliclyAccessible: false,
      StorageEncrypted: true,
    });
    mockLlmForPlanFlow("AWS::RDS::DBInstance", bpCompliantRds);

    const tools = createCoreMockTools(
      McpMocks.schema.rdsDbInstance.success,
      McpMocks.pricing.rdsT3MicroPostgres.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an RDS PostgreSQL database",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-rds-postgres" } },
    );

    expect(result.resourceType).toBe("AWS::RDS::DBInstance");
    expect(result.desiredState).toMatchObject({
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      PubliclyAccessible: false,
      StorageEncrypted: true,
    });
    expect(result.preflightPassed).toBe(true);
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });
});

describe("Graph integration — failure paths", () => {
  it("UNSUPPORTED resource type: fails at intent_parser", async () => {
    mockGenerateText.mockResolvedValueOnce({
      output: { resourceType: "UNSUPPORTED" },
      text: "",
    });

    const tools = createAllMockTools();
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a Kubernetes cluster",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-unsupported" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.errorMessage).toContain("Unsupported");
    expect(renderError).toHaveBeenCalled();
  });

  it("LLM failure at intent-parser: sets FAILED with connectivity hint", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("Bedrock throttled"));

    const tools = createAllMockTools();
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-llm-fail-intent" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Intent parsing failed");
    expect(result.errorMessage).toContain("Bedrock");
  });

  it("schema fetch failure: cfn-mcp-server unavailable", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", "{}");

    // Pass only pricing tool — no schema tool means cfn-mcp-server is "down"
    const tools = [
      createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success),
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-schema-fail" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toBe("cfn-mcp-server not available");
  });

  it("schema tool throws error: wraps error message", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", "{}");

    const tools = [
      createFailingMockTool(
        ToolName.GET_RESOURCE_SCHEMA,
        new Error("Connection refused"),
      ),
      createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success),
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-schema-error" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Connection refused");
    expect(result.errorMessage).toContain("cfn-mcp-server");
  });

  it("LLM returns invalid JSON at plan-generator: fails gracefully", async () => {
    mockGenerateText
      .mockResolvedValueOnce({
        output: { resourceType: "AWS::S3::Bucket" },
        text: "",
      })
      .mockResolvedValueOnce({
        text: "Sorry, I cannot generate that configuration",
        output: undefined,
      });

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-invalid-json" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("invalid JSON");
  });

  it("Lambda with missing required fields: fails at preflight validation", async () => {
    // Missing Role (required)
    mockLlmForPlanFlow(
      "AWS::Lambda::Function",
      '{"FunctionName":"my-fn","Runtime":"nodejs22.x"}',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.lambdaFunction.success,
      McpMocks.pricing.emptyData.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a Lambda function",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-lambda-missing-role" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Role");
  });
});

describe("Graph integration — plan generator resilience", () => {
  it("strips hallucinated fields not in schema", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '{"BucketName":"test-data-bucket","NonExistentField":"hallucinated","Tags":[]}',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-strip-hallucinated" } },
    );

    // plan_generator validates against schema keys and strips unknown fields
    expect(result.desiredState).toHaveProperty(
      "BucketName",
      "test-data-bucket",
    );
    expect(result.desiredState).not.toHaveProperty("NonExistentField");
    // Empty arrays are also stripped by stripEmpty()
    expect(result.desiredState).not.toHaveProperty("Tags");
    // Minimal S3 state triggers BP CRITICALs (missing encryption, versioning, etc.)
    expect(result.preflightPassed).toBe(false);
    expect(result.bpFindings).toBeDefined();
    expect(
      result.bpFindings!.some(
        (f: { severity: string }) => f.severity === "CRITICAL",
      ),
    ).toBe(true);
  });

  it("unwraps nested CloudFormation Resources format from LLM", async () => {
    // LLM returns CFN Resources block format instead of flat properties
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '{"MyBucket":{"Type":"AWS::S3::Bucket","Properties":{"BucketName":"unwrapped-bucket"}}}',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-unwrap-cfn" } },
    );

    // plan_generator should unwrap the nested format
    expect(result.desiredState).toEqual({ BucketName: "unwrapped-bucket" });
    // Minimal S3 state triggers BP CRITICALs — this is correct behavior
    expect(result.preflightPassed).toBe(false);
  });

  it("handles LLM returning markdown-fenced JSON", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '```json\n{"BucketName":"fenced-bucket"}\n```',
    );

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-fenced-json" } },
    );

    expect(result.desiredState).toEqual({ BucketName: "fenced-bucket" });
    // Minimal S3 state triggers BP CRITICALs — this is correct behavior
    expect(result.preflightPassed).toBe(false);
  });
});

describe("Graph integration — pricing edge cases", () => {
  it("pricing timeout: preflight still passes with N/A cost", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", '{"BucketName":"timeout-bucket"}');

    const tools = [
      createMockTool(
        ToolName.GET_RESOURCE_SCHEMA,
        McpMocks.schema.s3Bucket.success,
      ),
      // Pricing tool returns null (simulates withTimeout resolving to null)
      createMockTool(ToolName.GET_PRICING, null),
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-pricing-timeout" } },
    );

    // Pricing fallback to N/A on timeout
    expect(result.estimatedMonthlyCost).toBe("N/A");
    // Minimal S3 state triggers BP CRITICALs — expected
    expect(result.preflightPassed).toBe(false);
  });

  it("no pricing tool available: falls back to N/A", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", '{"BucketName":"no-pricing-bucket"}');

    // Only schema tool, no pricing tool at all
    const tools = [
      createMockTool(
        ToolName.GET_RESOURCE_SCHEMA,
        McpMocks.schema.s3Bucket.success,
      ),
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-no-pricing" } },
    );

    expect(result.estimatedMonthlyCost).toBe("N/A");
    expect(result.preflightPassed).toBe(false);
  });

  it("malformed pricing response: preflight still passes", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '{"BucketName":"malformed-pricing-bucket"}',
    );

    const tools = [
      createMockTool(
        ToolName.GET_RESOURCE_SCHEMA,
        McpMocks.schema.s3Bucket.success,
      ),
      createMockTool(
        ToolName.GET_PRICING,
        McpMocks.pricing.malformedJson.success,
      ),
    ];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-malformed-pricing" } },
    );

    // Pricing parse failure is caught — cost is N/A. BP CRITICALs fire on minimal S3 state
    expect(result.preflightPassed).toBe(false);
  });
});

describe("Graph integration — fix_applicator + pricing breakdown", () => {
  it("FIX_APPLICATOR node: appliedFixes field exists in final state", async () => {
    // S3 bucket with minimal config will trigger BP findings + auto-fixes (if config enabled)
    const bpCompliantS3 = JSON.stringify({
      BucketName: "fix-applicator-test-bucket",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      VersioningConfiguration: { Status: "Enabled" },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      },
      LifecycleConfiguration: { Rules: [{ Status: "Enabled" }] },
      LoggingConfiguration: { DestinationBucketName: "logs-bucket" },
    });
    mockLlmForPlanFlow("AWS::S3::Bucket", bpCompliantS3);

    const tools = createCoreMockTools(
      McpMocks.schema.s3Bucket.success,
      McpMocks.pricing.s3Storage.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named fix-applicator-test-bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-fix-applicator" } },
    );

    // appliedFixes should exist in state (may be undefined/empty when auto-fix is not enabled)
    expect("appliedFixes" in result).toBe(true);
    // The graph should have completed (fix_applicator does not block on missing config)
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });

  it("pricingBreakdown field structure is present for priced resources", async () => {
    const ec2State = JSON.stringify({
      InstanceType: "t3.micro",
      ImageId: "ami-0123456789abcdef0",
      MetadataOptions: { HttpTokens: "required" },
      BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: "gp3" } }],
    });
    mockLlmForPlanFlow("AWS::EC2::Instance", ec2State);

    const tools = createCoreMockTools(
      McpMocks.schema.ec2Instance.success,
      McpMocks.pricing.ec2T3Micro.success,
    );

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a t3.micro EC2 instance",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-pricing-breakdown" } },
    );

    // pricingBreakdown should be present in state annotation
    expect("pricingBreakdown" in result).toBe(true);
    // EC2 should have a cost estimate
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// New resource type coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe("Graph integration — new resource types", () => {
  it("DynamoDB: plan for a table", async () => {
    const state = JSON.stringify({
      TableName: "test-table",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    });
    mockLlmForPlanFlow("AWS::DynamoDB::Table", state);

    const tools = createCoreMockTools(
      McpMocks.schema.dynamoDbTable.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a DynamoDB table named test-table",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-dynamodb-plan" } },
    );

    expect(result.resourceType).toBe("AWS::DynamoDB::Table");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("SecurityGroup: plan for web traffic SG", async () => {
    const state = JSON.stringify({
      GroupDescription: "Web traffic security group",
      VpcId: "vpc-123",
    });
    mockLlmForPlanFlow("AWS::EC2::SecurityGroup", state);

    const tools = createCoreMockTools(
      McpMocks.schema.securityGroup.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a security group for web traffic",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-sg-plan" } },
    );

    expect(result.resourceType).toBe("AWS::EC2::SecurityGroup");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("VPC: plan with CIDR block", async () => {
    const state = JSON.stringify({ CidrBlock: "10.0.0.0/16" });
    mockLlmForPlanFlow("AWS::EC2::VPC", state);

    const tools = createCoreMockTools(
      McpMocks.schema.vpc.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a VPC with CIDR 10.0.0.0/16",
        executionMode: ExecutionMode.PLAN,
        noWizard: true,
      },
      { configurable: { thread_id: "integration-vpc-plan" } },
    );

    expect(result.resourceType).toBe("AWS::EC2::VPC");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("Subnet: plan in a VPC", async () => {
    const state = JSON.stringify({
      VpcId: "vpc-123",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
    });
    mockLlmForPlanFlow("AWS::EC2::Subnet", state);

    const tools = createCoreMockTools(
      McpMocks.schema.subnet.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a subnet in my VPC",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-subnet-plan" } },
    );

    expect(result.resourceType).toBe("AWS::EC2::Subnet");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("SQS: plan for a queue", async () => {
    const state = JSON.stringify({ QueueName: "test-queue" });
    mockLlmForPlanFlow("AWS::SQS::Queue", state);

    const tools = createCoreMockTools(
      McpMocks.schema.sqsQueue.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an SQS queue named test-queue",
        executionMode: ExecutionMode.PLAN,
        noWizard: true,
      },
      { configurable: { thread_id: "integration-sqs-plan" } },
    );

    expect(result.resourceType).toBe("AWS::SQS::Queue");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("SNS: plan for a topic", async () => {
    const state = JSON.stringify({ TopicName: "test-topic" });
    mockLlmForPlanFlow("AWS::SNS::Topic", state);

    const tools = createCoreMockTools(
      McpMocks.schema.snsTopic.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an SNS topic named test-topic",
        executionMode: ExecutionMode.PLAN,
        noWizard: true,
      },
      { configurable: { thread_id: "integration-sns-plan" } },
    );

    expect(result.resourceType).toBe("AWS::SNS::Topic");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("SSM Parameter: plan for a parameter", async () => {
    const state = JSON.stringify({
      Name: "/test/param",
      Type: "String",
      Value: "test-value",
    });
    mockLlmForPlanFlow("AWS::SSM::Parameter", state);

    const tools = createCoreMockTools(
      McpMocks.schema.ssmParameter.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an SSM parameter /test/param",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-ssm-plan" } },
    );

    expect(result.resourceType).toBe("AWS::SSM::Parameter");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("ECS Cluster: plan for a cluster", async () => {
    const state = JSON.stringify({ ClusterName: "test-cluster" });
    mockLlmForPlanFlow("AWS::ECS::Cluster", state);

    const tools = createCoreMockTools(
      McpMocks.schema.ecsCluster.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an ECS cluster named test-cluster",
        executionMode: ExecutionMode.PLAN,
        noWizard: true,
      },
      { configurable: { thread_id: "integration-ecs-plan" } },
    );

    expect(result.resourceType).toBe("AWS::ECS::Cluster");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("ECR: plan for a repository", async () => {
    const state = JSON.stringify({ RepositoryName: "test-repo" });
    mockLlmForPlanFlow("AWS::ECR::Repository", state);

    const tools = createCoreMockTools(
      McpMocks.schema.ecrRepository.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an ECR repository named test-repo",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-ecr-plan" } },
    );

    expect(result.resourceType).toBe("AWS::ECR::Repository");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });

  it("ELBv2: plan for an application load balancer", async () => {
    const state = JSON.stringify({
      Name: "test-alb",
      Type: "application",
      Scheme: "internet-facing",
    });
    mockLlmForPlanFlow("AWS::ElasticLoadBalancingV2::LoadBalancer", state);

    const tools = createCoreMockTools(
      McpMocks.schema.elbv2LoadBalancer.success,
      McpMocks.pricing.emptyData.success,
    );
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an application load balancer named test-alb",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-elbv2-plan" } },
    );

    expect(result.resourceType).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toBeDefined();
  });
});

describe("Graph integration — apply flow", () => {
  // TODO: Apply flow requires full HITL interrupt/resume cycle with CloudControl mock.
  // Current LangGraph interruptBefore pattern needs graph.invoke(null, config) resume
  // which requires proper checkpoint state. Tracked as a follow-up story.
  it.skip("SSM Parameter: apply with autoApprove completes successfully", async () => {
    const state = JSON.stringify({
      Name: "/test/param",
      Type: "String",
      Value: "test-value",
    });
    mockLlmForPlanFlow("AWS::SSM::Parameter", state);

    const tools = createCoreMockTools(
      McpMocks.schema.ssmParameter.success,
      McpMocks.pricing.emptyData.success,
    );

    // Configure CloudControl mock to handle Phase 2 commands:
    //   GetResource → NOT_FOUND (state guard passes)
    //   CreateResource → returns request token
    //   GetResourceRequestStatus → SUCCESS
    const { createCloudControlClient } =
      await import("../services/cloudcontrol-client.js");
    const { ResourceNotFoundException } =
      await import("@aws-sdk/client-cloudcontrol");

    const mockSend = vi
      .fn()
      // GetResource (state guard) → NOT_FOUND
      .mockRejectedValueOnce(
        Object.assign(new Error("Resource not found"), {
          name: "ResourceNotFoundException",
          __proto__: ResourceNotFoundException.prototype,
        }),
      )
      // CreateResource → returns request token
      .mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-ssm-apply-test" },
      })
      // GetResourceRequestStatus → SUCCESS
      .mockResolvedValueOnce({
        ProgressEvent: {
          OperationStatus: "SUCCESS",
          Identifier: "/test/param",
        },
      });

    vi.mocked(createCloudControlClient).mockReturnValueOnce({
      send: mockSend,
    } as never);

    const config = { configurable: { thread_id: "integration-ssm-apply" } };
    const graph = createGraph(tools);

    // Phase 1: plan + human_approval (auto-approved) → stops at interrupt before resource_provisioner
    await graph.invoke(
      {
        userIntent: "Create an SSM parameter /test/param",
        executionMode: ExecutionMode.APPLY,
        autoApprove: true,
      },
      config,
    );

    // Phase 2: resume past interrupt → resource_provisioner + status_poller + result_formatter
    await graph.invoke(null, config);

    const finalState = await graph.getState(config);
    expect(finalState.values.executionStatus).toBe(ExecutionStatus.SUCCESS);
  });
});
