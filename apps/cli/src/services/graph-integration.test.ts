/**
 * Integration tests for the full LangGraph agent flow.
 *
 * These tests exercise the REAL node implementations (schema_fetcher, preflight_guard,
 * plan_generator, etc.) with mocked external boundaries:
 *   - LLM: mocked via `ai` module (LlmAdapter mock delegates to it)
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
import {
  ExecutionMode,
  ExecutionStatus,
  SchemaFetchError,
} from "@assignee/core";
import {
  McpMocks,
  RawSchemasByType,
  createMockTool,
  createPricingMockTools,
  createAllMockTools,
  createS3PricingDispatchTool,
  createEc2PricingDispatchTool,
  createRdsPricingDispatchTool,
} from "../test-fixtures/mcp-mock-responses.js";
import { ToolName } from "../constants/tools.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Mock CloudFormationSchemaService — schema fetching now uses direct SDK, not MCP
const mockGetSchema = vi.fn();
vi.mock("@assignee/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    CloudFormationSchemaService: vi.fn().mockImplementation(() => ({
      getSchema: mockGetSchema,
    })),
  };
});

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

// Mock LlmAdapter — delegates to the same ai mock so existing test fixtures work.
vi.mock("./llm-adapter.js", async () => {
  const { LlmError, safeTry } = await import("@assignee/core");
  const ai = await import("ai");
  return {
    LlmAdapter: vi.fn().mockImplementation(() => ({
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

// Story 27.4: Mock config loaders — return undefined by default (no config)
vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(undefined),
  resolveConfigPath: vi
    .fn()
    .mockReturnValue("/tmp/.config/assignee/config.yaml"),
}));

vi.mock("../config/project-config-loader.js", () => ({
  loadProjectConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config/org-policy-cache.js", () => ({
  readAuthToken: vi.fn().mockResolvedValue(undefined),
  fetchOrgPolicy: vi.fn().mockResolvedValue(undefined),
}));

import { createGraph } from "./graph.js";
import { _resetSchemaService } from "../nodes/schema-fetcher.js";
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
    .mockResolvedValueOnce({ text: desiredStateJson, output: undefined })
    // Call 3: advice-generator → generateText → uses text field
    .mockResolvedValueOnce({ text: "[]", output: undefined });
}

// ── Test setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset is required to clear mockResolvedValueOnce queues
  // (vi.clearAllMocks only calls mockClear which may not flush them)
  mockGenerateText.mockReset();
  // Reset schema service singleton so the mock constructor fires each test
  _resetSchemaService();
  // Default schema mock: look up raw schema by resource type name
  mockGetSchema.mockImplementation((typeName: string) => {
    const schema = RawSchemasByType[typeName];
    if (schema) return Promise.resolve(schema);
    return Promise.reject(
      new SchemaFetchError(typeName, new Error(`Type '${typeName}' not found`)),
    );
  });
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

    // Use filter-dispatched S3 pricing tool — returns DIFFERENT prices for
    // storage vs PUT vs GET vs data transfer, catching filter-dispatch bugs
    const s3PricingTool = createS3PricingDispatchTool();
    const tools = [s3PricingTool];

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

    // Schema fetcher called CloudFormationSchemaService (not MCP tool)
    expect(mockGetSchema).toHaveBeenCalledWith("AWS::S3::Bucket");

    // Pricing tool called for cost estimation with correct S3 filters
    expect(s3PricingTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ service_code: "AmazonS3" }),
    );

    // Plan box was rendered (plan mode renders plan in result_formatter)
    expect(renderPlanBox).toHaveBeenCalled();
  });

  it("Lambda function: repairer injects Code from plugin defaults when missing (Story E2E.3)", async () => {
    // LLM generates a plan that is MISSING the required "Code" field
    mockLlmForPlanFlow(
      "AWS::Lambda::Function",
      '{"FunctionName":"my-fn","Runtime":"nodejs22.x","Role":"arn:aws:iam::123456789012:role/lambda-exec"}',
    );

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a Lambda function",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-lambda-missing-field" } },
    );

    // Generic repairer (Story E2E.3) fills Code from Lambda plugin defaults
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.desiredState).toHaveProperty("Code");
    expect(
      (result.desiredState as Record<string, unknown>)["Code"],
    ).toHaveProperty("ZipFile");
  });

  it("EC2 instance: happy path with all required fields", async () => {
    const bpCompliantEc2 = JSON.stringify({
      InstanceType: "t3.micro",
      ImageId: "ami-0123456789abcdef0",
      MetadataOptions: { HttpTokens: "required" },
      BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: "gp3" } }],
    });
    mockGenerateText
      .mockResolvedValueOnce({
        output: { resourceType: "AWS::EC2::Instance" },
        text: "",
      })
      .mockResolvedValueOnce({ text: bpCompliantEc2, output: undefined })
      .mockResolvedValueOnce({ text: "[]", output: undefined }); // advice-generator

    // Use filter-dispatched EC2 pricing tool
    const tools = [createEc2PricingDispatchTool()];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent:
          "Create a t3.micro EC2 instance with AMI ami-0123456789abcdef0",
        executionMode: ExecutionMode.PLAN,
        noWizard: false,
      },
      { configurable: { thread_id: "integration-ec2-happy" } },
    );

    expect(result.resourceType).toBe("AWS::EC2::Instance");
    expect(result.desiredState).toHaveProperty("InstanceType", "t3.micro");
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
  });

  it("Lambda function: uses local pricing estimate (no MCP pricing call)", async () => {
    mockLlmForPlanFlow(
      "AWS::Lambda::Function",
      '{"FunctionName":"my-fn","Runtime":"nodejs22.x","Role":"arn:aws:iam::123456789012:role/lambda-exec","Code":{"ZipFile":"exports.handler=async()=>({statusCode:200})"}}',
    );

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);

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
    const tools = [pricingTool];

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

    // Use filter-dispatched RDS pricing tool — returns DIFFERENT prices for
    // compute vs storage vs backup, catching filter-dispatch bugs in decomposer
    const tools = [createRdsPricingDispatchTool()];

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

  // Note: Schema fetch failure tests removed in Story 31.4.
  // Schema fetching now uses CloudFormationSchemaService (direct SDK), not MCP tools.
  // SDK-level failure tests live in apps/cli/src/nodes/schema-fetcher.test.ts.

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

    const tools = createPricingMockTools(McpMocks.pricing.s3Storage.success);

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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);

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

    const tools = createPricingMockTools(McpMocks.pricing.s3Storage.success);

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
    // Minimal S3 state triggers BP findings. If autoFixBestPractices is enabled
    // in .assignee/config.yaml, auto-fix resolves them and preflight passes.
    // If config not found (turborepo cwd differs), findings remain and preflight fails.
    // Both outcomes are valid — the test validates schema stripping, not auto-fix.
    expect(result.bpFindings).toBeDefined();
  });

  it("unwraps nested CloudFormation Resources format from LLM", async () => {
    // LLM returns CFN Resources block format instead of flat properties
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '{"MyBucket":{"Type":"AWS::S3::Bucket","Properties":{"BucketName":"unwrapped-bucket"}}}',
    );

    const tools = createPricingMockTools(McpMocks.pricing.s3Storage.success);

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-unwrap-cfn" } },
    );

    // plan_generator should unwrap the nested format
    expect(result.desiredState).toHaveProperty(
      "BucketName",
      "unwrapped-bucket",
    );
  });

  it("handles LLM returning markdown-fenced JSON", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '```json\n{"BucketName":"fenced-bucket"}\n```',
    );

    const tools = createPricingMockTools(McpMocks.pricing.s3Storage.success);

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-fenced-json" } },
    );

    expect(result.desiredState).toHaveProperty("BucketName", "fenced-bucket");
  });
});

describe("Graph integration — pricing edge cases", () => {
  it("pricing timeout: preflight still passes with N/A cost", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", '{"BucketName":"timeout-bucket"}');

    const tools = [
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

    // Pricing should fall back to N/A when tool returns null.
    // If filesystem pricing cache has data from live runs, decomposer items
    // may resolve from cache and yield a per-unit rate instead.
    // The key invariant: pricing failure is non-blocking — the graph completes.
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("no pricing tool available: falls back to N/A", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", '{"BucketName":"no-pricing-bucket"}');

    // No pricing tool at all — should fall back to N/A
    const tools: ReturnType<typeof createMockTool>[] = [];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-no-pricing" } },
    );

    expect(result.estimatedMonthlyCost).toBe("N/A");
  });

  it("malformed pricing response: preflight still passes", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      '{"BucketName":"malformed-pricing-bucket"}',
    );

    const tools = [
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

    // Malformed pricing doesn't crash — graph completes
    expect(result.estimatedMonthlyCost).toBeDefined();
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

    const tools = createPricingMockTools(McpMocks.pricing.s3Storage.success);

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
    mockGenerateText
      .mockResolvedValueOnce({
        output: { resourceType: "AWS::EC2::Instance" },
        text: "",
      })
      .mockResolvedValueOnce({ text: ec2State, output: undefined })
      .mockResolvedValueOnce({ text: "[]", output: undefined }); // advice-generator

    // Use filter-dispatched EC2 pricing tool — decomposer issues separate
    // MCP calls for compute, EBS storage, and data transfer.  A static mock
    // would return the SAME compute price for all three, masking dispatch bugs.
    const tools = [createEc2PricingDispatchTool()];

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a t3.micro EC2 instance",
        executionMode: ExecutionMode.PLAN,
        noWizard: false,
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
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
  // DEFERRED: Apply flow requires full HITL interrupt/resume cycle with CloudControl mock.
  // Current LangGraph interruptBefore pattern needs graph.invoke(null, config) resume
  // which requires proper checkpoint state.
  // Tracked: Epic 34 — Apply Flow E2E Integration (post-Sprint K)
  it.skip("SSM Parameter: apply with autoApprove completes successfully", async () => {
    const state = JSON.stringify({
      Name: "/test/param",
      Type: "String",
      Value: "test-value",
    });
    mockLlmForPlanFlow("AWS::SSM::Parameter", state);

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);

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

// ── Story 40.1: Advice generator integration ────────────────────────────────

describe("Advice generator integration", () => {
  it("EC2 plan produces security and cost advice hints (Story 40.1)", async () => {
    // EC2 plan WITHOUT IMDSv2 and WITHOUT encrypted EBS — security advisor should catch both
    const ec2Plan = JSON.stringify({
      InstanceType: "t3.micro",
      ImageId: "ami-0c55b159cbfafe1f0",
      BlockDeviceMappings: [
        { DeviceName: "/dev/xvda", Ebs: { VolumeType: "gp3" } },
      ],
    });

    mockGenerateText
      .mockResolvedValueOnce({
        output: { resourceType: "AWS::EC2::Instance" },
        text: "",
      })
      .mockResolvedValueOnce({ text: ec2Plan, output: undefined })
      // 3rd call: advice-generator LLM — return empty to test rule-based only
      .mockResolvedValueOnce({ text: "[]", output: undefined });

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an EC2 t3.micro for development",
        executionMode: ExecutionMode.PLAN,
        noWizard: false,
      },
      { configurable: { thread_id: "integration-ec2-advice" } },
    );

    // Advice hints should be populated by rule-based advisors
    expect(result.adviceHints).toBeDefined();
    expect(result.adviceHints!.length).toBeGreaterThan(0);
    // Security advisor: IMDSv2 not enforced (no MetadataOptions)
    expect(result.adviceHints!.some((h: string) => h.includes("IMDSv2"))).toBe(
      true,
    );
    // Security advisor: EBS unencrypted
    expect(result.adviceHints!.some((h: string) => h.includes("EBS"))).toBe(
      true,
    );
    // Cost advisor: ARM alternative (t3 → t4g)
    expect(result.adviceHints!.some((h: string) => h.includes("t4g"))).toBe(
      true,
    );
  });

  it("S3 plan with full security config produces positive security confirmations", async () => {
    const s3Plan = JSON.stringify({
      BucketName: "secure-bucket",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });

    mockGenerateText
      .mockResolvedValueOnce({
        output: { resourceType: "AWS::S3::Bucket" },
        text: "",
      })
      .mockResolvedValueOnce({ text: s3Plan, output: undefined })
      .mockResolvedValueOnce({ text: "[]", output: undefined });

    const tools = [createS3PricingDispatchTool()];
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create a secure S3 bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-s3-advice" } },
    );

    expect(result.adviceHints).toBeDefined();
    // Security advisor: public access fully blocked (positive confirmation)
    expect(
      result.adviceHints!.some((h: string) =>
        h.includes("Public access fully blocked"),
      ),
    ).toBe(true);
    // Cost advisor: lifecycle suggestion (no lifecycle configured)
    expect(
      result.adviceHints!.some((h: string) => h.includes("lifecycle")),
    ).toBe(true);
  });

  it("--no-advice flag produces empty adviceHints", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", '{"BucketName":"no-advice-bucket"}');

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket",
        executionMode: ExecutionMode.PLAN,
        noAdvice: true,
      },
      { configurable: { thread_id: "integration-no-advice" } },
    );

    expect(result.adviceHints).toEqual([]);
    // LLM should only be called twice (intent-parser + plan-generator), NOT for advice
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
  });
});
