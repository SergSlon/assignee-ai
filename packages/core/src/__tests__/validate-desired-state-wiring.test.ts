/**
 * Epic 94 Wave 1 R1 — integration test that proves
 * `validateDesiredStateNode` is wired into the real graph.
 *
 * Without the fix this whole file fails: the 70-char bucket name flows
 * through plan_generator → advice_generator → bp_evaluator → preflight
 * → result_formatter and the final state is NOT marked FAILED. The
 * regression (Epic 92 Story 92.1.c) was that the node existed (+ 28 unit
 * tests) but was never inserted into `create-graph.ts`, so every S3
 * bucket-name rule silently passed through to CloudControl at APPLY
 * time.
 *
 * Test strategy:
 *   - Drive the real graph with a 70-character bucket-name intent.
 *   - Mock the intent-parser LLM call to classify as `AWS::S3::Bucket`.
 *   - Mock the plan-generator LLM call to emit the invalid BucketName.
 *   - Let the real `validateDesiredStateNode` run; assert the final
 *     state carries `executionStatus === FAILED` AND
 *     `state.error.code === "INVALID_DESIRED_STATE"` AND
 *     `errorMessage` contains the `[ERROR]` / `[FIX]` triple.
 *
 * Real fixtures only — no synthetic helpers that evade domain logic.
 * The existing `mcp-mock-responses` fixtures come from earlier integration
 * tests and contain real CFN schemas + real AWS pricing-API response
 * shapes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AssigneeError,
  ExecutionMode,
  ExecutionStatus,
  SchemaFetchError,
} from "../index.js";
import {
  RawSchemasByType,
  createPricingMockTools,
  McpMocks,
} from "../test-fixtures/mcp-mock-responses.js";
import { ErrorCode } from "../constants/errors.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Mock CloudFormationSchemaService — deterministic schema lookup.
const mockGetSchema = vi.fn();
vi.mock("../index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class CloudFormationSchemaService {
    getSchema = mockGetSchema;
  }
  return {
    ...actual,
    CloudFormationSchemaService,
  };
});
vi.mock("@assignee/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class CloudFormationSchemaService {
    getSchema = mockGetSchema;
  }
  return {
    ...actual,
    CloudFormationSchemaService,
  };
});

// Prevent real AWS CloudControl calls.
vi.mock("../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn(() => ({ send: () => undefined })),
}));

// Intercept every LLM call made through `ai`.
const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: { object: vi.fn((opts: unknown) => opts) },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => () => undefined,
}));

// LlmAdapter stub — delegates to the `ai` mock above.
vi.mock("../llm/adapter.js", async () => {
  const { LlmError, safeTry } = await import("../index.js");
  const ai = await import("ai");
  class LlmAdapter {
    async generateStructured(
      prompt: string,
      schema: unknown,
      options?: { maxTokens?: number },
    ) {
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
    }
    async generateText(prompt: string, options?: { maxTokens?: number }) {
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
    }
  }
  return { LlmAdapter };
});

// Display stubs — keep the test terminal quiet.
const _displayStubs = vi.hoisted(() => ({
  renderPlanBox: vi.fn(),
  renderError: vi.fn(),
  renderApplySuccess: vi.fn(),
  renderOutro: vi.fn(),
  renderIntro: vi.fn(),
  renderHitlConfirm: vi.fn().mockResolvedValue(false),
  renderHitlCompoundConfirm: vi.fn().mockResolvedValue(false),
  renderDependencyPlan: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderCompoundPartialFailure: vi.fn(),
  renderDocHelp: vi.fn().mockResolvedValue(undefined),
  renderTradeoffHelp: vi.fn(),
  startSpinner: vi.fn(),
  updateSpinner: vi.fn(),
  stopSpinner: vi.fn(),
  renderOptionPrompt: vi.fn(),
  renderAdvancedConfirm: vi.fn().mockResolvedValue(false),
  renderSecurityWarnings: vi.fn(),
  renderResourceTable: vi.fn(),
  renderEmptyList: vi.fn(),
  renderStatusSummary: vi.fn(),
  renderEmptyStatus: vi.fn(),
  promptFixSelection: vi.fn().mockResolvedValue(null),
  runReviewAnswers: vi.fn(),
}));
vi.mock("../utils/display.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/display.js")>(
    "../utils/display.js",
  );
  return { ...actual, ..._displayStubs };
});

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: () => false,
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  spinner: () => ({
    start: () => undefined,
    stop: () => undefined,
    message: () => undefined,
  }),
}));

vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: async () => undefined,
  resolveConfigPath: () => "/tmp/.config/assignee/config.yaml",
}));

vi.mock("../config/project-config-loader.js", () => ({
  loadProjectConfig: async () => undefined,
}));

vi.mock("../config/org-policy-cache.js", () => ({
  readAuthToken: async () => undefined,
  fetchOrgPolicy: async () => undefined,
}));

import { createGraph } from "../graph/create-graph.js";
import { _resetSchemaService } from "../graph/nodes/schema-fetcher.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Script the LLM for a plan flow: intent-parser classifies as S3, plan-
 * generator returns the given desiredState JSON, advice-generator returns
 * an empty hints array. All further calls fall back to empty advice so
 * compound plan iterations (if any) don't throw.
 */
function mockLlmForPlanFlow(resourceType: string, desiredStateJson: string) {
  mockGenerateText
    .mockResolvedValueOnce({ output: { resourceType }, text: "" })
    .mockResolvedValueOnce({ text: desiredStateJson, output: undefined })
    .mockResolvedValueOnce({ text: "[]", output: undefined })
    .mockResolvedValue({ text: "[]", output: undefined });
}

// ── Test setup ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  const display = await import("../utils/display.js");
  vi.mocked(display.renderHitlConfirm).mockResolvedValue(false);
  vi.mocked(display.renderHitlCompoundConfirm).mockResolvedValue(false);
  vi.mocked(display.renderDocHelp).mockResolvedValue(null);
  vi.mocked(display.renderAdvancedConfirm).mockResolvedValue(false);
  mockGenerateText.mockReset();
  _resetSchemaService();
  mockGetSchema.mockImplementation((typeName: string) => {
    const schema = RawSchemasByType[typeName];
    if (schema) return Promise.resolve(schema);
    return Promise.reject(
      new SchemaFetchError(typeName, new Error(`Type '${typeName}' not found`)),
    );
  });
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

// ═══════════════════════════════════════════════════════════════════════════
// Tests — validate-desired-state wired into the graph
// ═══════════════════════════════════════════════════════════════════════════

describe("validateDesiredStateNode — graph wiring (Epic 94 R1 A-01)", () => {
  it("a 70-char bucket name fails the plan with INVALID_DESIRED_STATE", async () => {
    const longName = "a".repeat(70);
    expect(longName.length).toBe(70);
    const invalidPlan = JSON.stringify({
      BucketName: longName,
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
    });
    mockLlmForPlanFlow("AWS::S3::Bucket", invalidPlan);

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);

    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: `Create an S3 bucket named ${longName}`,
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-validate-70char" } },
    );

    // Core assertion: validate-desired-state actually ran and produced
    // the typed failure. Before Epic 94 R1 the node was never invoked
    // so executionStatus would be PENDING / SUCCESS and the 70-char
    // name would silently reach the apply layer.
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("[ERROR]");
    expect(result.errorMessage).toContain("[FIX]");
    expect(result.errorMessage).toContain("3-63");

    // The machine-readable code that the CLI JSON envelope stamps on
    // stdout. Without this assertion a future refactor could drop the
    // AssigneeError without the CLI envelope path noticing until an
    // e2e run.
    expect(result.error).toBeInstanceOf(AssigneeError);
    expect(result.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("an IPv4-shaped bucket name fails with INVALID_DESIRED_STATE", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      JSON.stringify({ BucketName: "192.168.1.1" }),
    );

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named 192.168.1.1",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-validate-ipv4" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("IPv4");
    expect(result.error).toBeInstanceOf(AssigneeError);
    expect(result.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("an xn-- prefix fails with INVALID_DESIRED_STATE", async () => {
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      JSON.stringify({ BucketName: "xn--example-bucket" }),
    );

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named xn--example-bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-validate-xn" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("xn--");
    expect(result.error).toBeInstanceOf(AssigneeError);
    expect(result.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("adjacent dots ('app..logs') fail with INVALID_DESIRED_STATE", async () => {
    // NOTE: we intentionally use phrasing WITHOUT the "named" / "called"
    // keyword so `extractResourceName` (intent-parser.ts) does not try
    // to extract the bucket name via its word-boundary regex
    // (`[A-Za-z][A-Za-z0-9_-]{0,63}`) which strips dots. The mocked LLM
    // emits the dotted name directly into `desiredState.BucketName` —
    // which is exactly the regression class this node guards (LLM emits
    // an invalid CFN-style BucketName that the downstream sanitizer
    // does NOT rewrite).
    mockLlmForPlanFlow(
      "AWS::S3::Bucket",
      JSON.stringify({ BucketName: "app..logs" }),
    );

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket for storing logs",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-validate-dots" } },
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("adjacent dots");
    expect(result.error).toBeInstanceOf(AssigneeError);
    expect(result.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("a valid bucket name passes through without triggering the validator", async () => {
    const validPlan = JSON.stringify({
      BucketName: "assignee-wiring-test-prod",
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
    });
    mockLlmForPlanFlow("AWS::S3::Bucket", validPlan);

    const tools = createPricingMockTools(McpMocks.pricing.emptyData.success);
    const graph = createGraph(tools);
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named assignee-wiring-test-prod",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "integration-validate-happy" } },
    );

    // The valid path does NOT stamp `error` or FAILED — the graph
    // walks past validate_desired_state → advice_generator →
    // bp_evaluator → ... → result_formatter as before.
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    expect(result.error).toBeUndefined();
  });
});
