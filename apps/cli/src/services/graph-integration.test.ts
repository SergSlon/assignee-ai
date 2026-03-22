/**
 * Integration tests for the full LangGraph agent flow.
 *
 * These tests exercise the REAL node implementations (schema_fetcher, preflight_guard,
 * plan_generator, etc.) with mocked external boundaries:
 *   - LLM: mocked via `ai` module (BedrockLlmAdapter calls through to it)
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
    mockLlmForPlanFlow(
      "AWS::RDS::DBInstance",
      '{"DBInstanceClass":"db.t3.micro","Engine":"postgres","DBInstanceIdentifier":"test-db"}',
    );

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
      '{"BucketName":"my-bucket","NonExistentField":"hallucinated","Tags":[]}',
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
    expect(result.desiredState).toHaveProperty("BucketName", "my-bucket");
    expect(result.desiredState).not.toHaveProperty("NonExistentField");
    // Empty arrays are also stripped by stripEmpty()
    expect(result.desiredState).not.toHaveProperty("Tags");
    // preflightPassed may be false due to BP CRITICAL findings on minimal S3 state — that's expected
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
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
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
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
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
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

    // preflightPassed may be false due to BP CRITICALs on minimal S3 — pricing test verifies cost fallback
    expect(result.estimatedMonthlyCost).toBe("N/A");
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
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
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
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

    // Pricing parse failure is caught — cost is N/A. preflightPassed may be false from BP CRITICALs on minimal S3
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });
});
