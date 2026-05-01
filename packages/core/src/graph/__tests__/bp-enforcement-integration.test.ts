/**
 * BP enforcement level integration tests — full graph flow for every
 * enforcement level x execution mode combination.
 *
 * Exercises the REAL node implementations with mocked external boundaries:
 *   - LLM: mocked via `ai` module (LlmAdapter mock delegates to it)
 *   - MCP tools: mocked via test-fixtures/mcp-mock-responses.ts
 *   - CloudControl: mocked module to prevent real AWS calls
 *   - Display/Prompts: mocked to prevent TTY output
 *
 * IMPORTANT: noWizard=true causes the option_elicitor to apply plugin defaults
 * (e.g., S3 gets BucketEncryption, PublicAccessBlock, Versioning), which resolves
 * most blocking BP findings BEFORE preflight_guard ever sees them. Tests that need
 * blocking findings must use noWizard=false (the default) with non-TTY, which skips
 * the wizard without applying security defaults.
 *
 * Test matrix:
 *   1. enforce + blocking BPs → plan mode: findings present, preflightPassed=false
 *   2. enforce + blocking BPs → apply mode: blocked at result_formatter, preflightPassed=false
 *   3. enforce + no blocking BPs → apply mode: reaches human_approval, preflightPassed=true
 *   4. warn + blocking BPs → apply mode: reaches human_approval, preflightPassed=true
 *   5. skip + blocking BPs → apply mode: reaches human_approval, findings still present
 *   6. enforce + blocking BPs + autoApprove=true → apply: STILL blocked
 *   7. enforce + blocking BPs + noWizard=true → apply: noWizard defaults resolve BPs,
 *      but enforcement level is still respected (preflightPassed=true only because
 *      no blocking findings remain after defaults, not because noWizard bypasses enforcement)
 *
 * @see Epic 41, Story 41.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExecutionMode,
  ExecutionStatus,
  SchemaFetchError,
} from "../../index.js";
import {
  RawSchemasByType,
  createS3PricingDispatchTool,
} from "../../test-fixtures/mcp-mock-responses.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

// Mock CloudFormationSchemaService — schema fetching now uses direct SDK,
// not MCP. NOTE: Plain class survives vitest's mockReset:true between tests.
const mockGetSchema = vi.fn();
vi.mock("../../index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class CloudFormationSchemaService {
    getSchema = mockGetSchema;
  }
  return {
    ...actual,
    CloudFormationSchemaService,
  };
});

// Mock CloudControl client — prevents real AWS API calls. Default impl is
// re-installed in beforeEach because mockReset:true wipes vi.fn impls.
vi.mock("../../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn(),
}));

// Mock the AI SDK — intercepts all LLM calls made by BedrockLlmAdapter
const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  Output: { object: (opts: unknown) => opts },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => () => undefined,
}));

// Mock LlmAdapter — delegates to the same ai mock so existing test fixtures
// work. Plain class survives vitest's mockReset:true between tests.
vi.mock("../../llm/adapter.js", async () => {
  const { LlmError, safeTry } = await import("../../index.js");
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
// Mock display utilities — capture output without writing to terminal.
// Default impls re-installed in beforeEach (mockReset wipes them).
vi.mock("../../utils/display.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/display.js")>();
  return {
    ...actual,
    renderPlanBox: vi.fn(),
    renderError: vi.fn(),
    renderApplySuccess: vi.fn(),
    renderOutro: vi.fn(),
    renderIntro: vi.fn(),
    renderHitlConfirm: vi.fn(),
    renderHitlCompoundConfirm: vi.fn(),
    renderDependencyPlan: vi.fn(),
    renderCompoundSuccess: vi.fn(),
    renderDocHelp: vi.fn(),
    startSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
    renderOptionPrompt: vi.fn(),
    renderAdvancedConfirm: vi.fn(),
    promptFixSelection: vi.fn(),
  };
});

// Mock clack prompts (used by option-elicitor for spinners). Plain functions
// where call assertions are unnecessary so impls survive mockReset:true.
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

// Story 27.4: Mock config loaders — return undefined by default (no config).
// Plain functions so impls survive vitest's mockReset:true.
vi.mock("../../config/user-config-loader.js", () => ({
  loadUserConfig: async () => undefined,
  resolveConfigPath: () => "/tmp/.config/assignee/config.yaml",
}));

vi.mock("../../config/project-config-loader.js", () => ({
  loadProjectConfig: async () => undefined,
}));

vi.mock("../../config/org-policy-cache.js", () => ({
  readAuthToken: async () => undefined,
  fetchOrgPolicy: async () => undefined,
}));

import { createGraph } from "../create-graph.js";
// W11-S1: _resetSchemaService removed; schema service is now per-graph.
import { resetBPCache } from "../nodes/bp-evaluator.js";
import { createCloudControlClient } from "../../services/cloudcontrol-client.js";

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Configures mockGenerateText to handle both intent-parser (structured)
 * and plan-generator (text) calls in sequence.
 */
function mockLlmForPlanFlow(resourceType: string, desiredStateJson: string) {
  mockGenerateText
    // Call 1: intent-parser -> generateStructured -> uses output field
    .mockResolvedValueOnce({ output: { resourceType }, text: "" })
    // Call 2: plan-generator -> generateText -> uses text field
    .mockResolvedValueOnce({ text: desiredStateJson, output: undefined });
}

/** Minimal S3 bucket plan that intentionally LACKS encryption, versioning,
 *  public access block, etc. — triggers multiple blocking BP findings
 *  including BP-S3-006 (encryption) and BP-S3-001 (BlockPublicAcls).
 *
 *  MUST be used with noWizard=false + non-TTY to prevent the option_elicitor
 *  from applying plugin security defaults that would resolve these findings. */
const INSECURE_S3_PLAN = JSON.stringify({
  BucketName: "bp-enforcement-test-bucket",
});

/** S3 bucket plan that is fully compliant — has encryption, versioning,
 *  public access block, ownership controls, lifecycle, and logging. */
const COMPLIANT_S3_PLAN = JSON.stringify({
  BucketName: "compliant-bucket-test",
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

/**
 * Configures the CloudControl mock send function for a successful
 * create + poll workflow (S3 skips GetResource state guard).
 */
function configureMockSendForS3Success(
  mockSend: ReturnType<typeof vi.fn>,
  identifier: string,
) {
  // S3 skips state guard (no GetResource), goes straight to CreateResource
  mockSend
    .mockResolvedValueOnce({
      ProgressEvent: { RequestToken: `tok-${identifier}` },
    })
    .mockResolvedValueOnce({
      ProgressEvent: {
        OperationStatus: "SUCCESS",
        Identifier: identifier,
      },
    });
}

// ── Test setup ──────────────────────────────────────────────────────────────

let originalStdinIsTTY: boolean | undefined;
let originalStdoutIsTTY: boolean | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-install display mock impls (mockReset:true wipes them between tests).
  const display = await import("../../utils/display.js");
  vi.mocked(display.renderHitlConfirm).mockResolvedValue(false);
  vi.mocked(display.renderHitlCompoundConfirm).mockResolvedValue(false);
  vi.mocked(display.renderDocHelp).mockResolvedValue(null);
  vi.mocked(display.renderAdvancedConfirm).mockResolvedValue(false);
  vi.mocked(display.promptFixSelection).mockResolvedValue(null);
  vi.mocked(createCloudControlClient).mockReturnValue({
    send: vi.fn(),
  } as never);
  mockGenerateText.mockReset();
  // W11-S1: schema service is per-graph; no singleton reset needed.
  resetBPCache();
  mockGetSchema.mockImplementation((typeName: string) => {
    const schema = RawSchemasByType[typeName];
    if (schema) return Promise.resolve(schema);
    return Promise.reject(
      new SchemaFetchError(typeName, new Error(`Type '${typeName}' not found`)),
    );
  });
  originalStdinIsTTY = process.stdin.isTTY;
  originalStdoutIsTTY = process.stdout.isTTY;
  // Force non-TTY by default to skip option-elicitor interactive prompts.
  // With noWizard=false (default), non-TTY returns empty elicitedOptions,
  // preserving the raw LLM plan without security defaults.
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
    value: originalStdinIsTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutIsTTY,
    configurable: true,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. enforce + blocking BPs → plan mode
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — enforce + blocking BPs in plan mode", () => {
  it("graph runs to completion, BP findings present, preflightPassed=false", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];
    const config = { configurable: { thread_id: "bp-enforce-plan-blocking" } };
    const graph = createGraph(tools);

    // noWizard defaults to false; non-TTY skips wizard without applying
    // security defaults, so the raw insecure plan triggers blocking BPs.
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.PLAN,
        bpEnforcementLevel: "enforce",
        noWizard: false,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    // Plan mode routes to result_formatter; enforce blocks on BP findings
    expect(result.preflightPassed).toBe(false);

    // BP findings should be present with blocking entries
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(result.bpFindings)).toBe(true);
    expect(result.bpFindings!.length).toBeGreaterThan(0);
    const blockingFindings = result.bpFindings!.filter(
      (f: { blocking: boolean }) => f.blocking,
    );
    expect(blockingFindings.length).toBeGreaterThan(0);

    // Should include critical security rules
    const blockingIds = blockingFindings.map(
      (f: { practiceId: string }) => f.practiceId,
    );
    expect(blockingIds).toContain("BP-S3-006"); // Encryption
    expect(blockingIds).toContain("BP-S3-001"); // BlockPublicAcls

    // Plan mode never provisions — status remains PENDING
    expect(result.executionStatus).not.toBe(ExecutionStatus.SUCCESS);
    expect(result.executionStatus).not.toBe(ExecutionStatus.IN_PROGRESS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. enforce + blocking BPs → apply mode (blocked at result_formatter)
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — enforce + blocking BPs in apply mode", () => {
  it("graph stops at result_formatter (not human_approval), preflightPassed=false", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];
    const config = {
      configurable: { thread_id: "bp-enforce-apply-blocking" },
    };
    const graph = createGraph(tools);

    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "enforce",
        noWizard: false,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    // preflightPassed=false blocks the flow — routes to result_formatter
    expect(result.preflightPassed).toBe(false);

    // BP findings present with blocking entries
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(result.bpFindings)).toBe(true);
    const blockingFindings = result.bpFindings!.filter(
      (f: { blocking: boolean }) => f.blocking,
    );
    expect(blockingFindings.length).toBeGreaterThan(0);

    // Graph should have completed (no pending next steps) — it went to
    // result_formatter -> END, NOT to human_approval or resource_provisioner
    const graphState = await graph.getState(config);
    expect(graphState.next).toEqual([]);

    // Execution never reached provisioning
    expect(result.executionStatus).not.toBe(ExecutionStatus.SUCCESS);
    expect(result.executionStatus).not.toBe(ExecutionStatus.IN_PROGRESS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. enforce + no blocking BPs → apply mode (reaches human_approval)
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — enforce + compliant config in apply mode", () => {
  it("preflightPassed=true, graph reaches human_approval interrupt", async () => {
    // Use noWizard=true so the option_elicitor applies security defaults.
    // Combined with the compliant plan (which already has encryption, PAB,
    // versioning), all critical BPs are satisfied.
    mockLlmForPlanFlow("AWS::S3::Bucket", COMPLIANT_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];

    // Configure CloudControl for provisioning
    const { createCloudControlClient } =
      await import("../../services/cloudcontrol-client.js");
    const mockSend = vi.fn();
    configureMockSendForS3Success(mockSend, "compliant-bucket-test");
    vi.mocked(createCloudControlClient).mockReturnValueOnce({
      send: mockSend,
    } as never);

    const config = {
      configurable: { thread_id: "bp-enforce-apply-compliant" },
    };
    const graph = createGraph(tools);

    // Phase 1: plan -> bp_evaluator -> fix_applicator -> preflight (pass) -> human_approval -> interrupt
    await graph.invoke(
      {
        userIntent: "Create an S3 bucket named compliant-bucket-test",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "enforce",
        autoApprove: true,
        noWizard: true,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    // Phase 1 should stop at interruptBefore resource_provisioner
    const midState = await graph.getState(config);
    const midValues = midState.values as Record<string, unknown>;

    // preflightPassed should be true — compliant config has no blocking findings
    expect(midValues["preflightPassed"]).toBe(true);

    // Graph should be interrupted at resource_provisioner
    expect(midState.next).toContain("resource_provisioner");

    // Phase 2: resume -> resource_provisioner -> status_poller -> result_formatter
    await graph.invoke(null, config);

    const finalState = await graph.getState(config);
    const finalValues = finalState.values as Record<string, unknown>;

    expect(finalValues["executionStatus"]).toBe(ExecutionStatus.SUCCESS);
    expect(finalValues["resourceArn"]).toBe("compliant-bucket-test");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. warn + blocking BPs → apply mode (not blocked, reaches human_approval)
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — warn + blocking BPs in apply mode", () => {
  it("preflightPassed=true despite blocking findings, graph reaches human_approval", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];

    // Configure CloudControl for provisioning
    const { createCloudControlClient } =
      await import("../../services/cloudcontrol-client.js");
    const mockSend = vi.fn();
    configureMockSendForS3Success(mockSend, "bp-enforcement-test-bucket");
    vi.mocked(createCloudControlClient).mockReturnValueOnce({
      send: mockSend,
    } as never);

    const config = {
      configurable: { thread_id: "bp-warn-apply-blocking" },
    };
    const graph = createGraph(tools);

    // noWizard defaults to false; non-TTY preserves insecure plan
    await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "warn",
        autoApprove: true,
        noWizard: false,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    const midState = await graph.getState(config);
    const midValues = midState.values as Record<string, unknown>;

    // preflightPassed should be true — warn mode never blocks
    expect(midValues["preflightPassed"]).toBe(true);

    // BP findings SHOULD still be present with blocking entries
    // (bp_evaluator always runs, warn only affects preflight_guard behaviour)
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(midValues["bpFindings"])).toBe(true);
    const findings = midValues["bpFindings"] as Array<{
      blocking: boolean;
      practiceId: string;
    }>;
    const blockingFindings = findings.filter((f) => f.blocking);
    expect(blockingFindings.length).toBeGreaterThan(0);

    // Graph should be at resource_provisioner interrupt
    expect(midState.next).toContain("resource_provisioner");

    // Phase 2: resume -> provision -> poll -> result
    await graph.invoke(null, config);

    const finalState = await graph.getState(config);
    const finalValues = finalState.values as Record<string, unknown>;

    expect(finalValues["executionStatus"]).toBe(ExecutionStatus.SUCCESS);
    expect(finalValues["resourceArn"]).toBe("bp-enforcement-test-bucket");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. skip + blocking BPs → apply mode (not blocked, findings still present)
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — skip + blocking BPs in apply mode", () => {
  it("preflightPassed=true, BP findings present (evaluator still runs), reaches human_approval", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];

    // Configure CloudControl for provisioning
    const { createCloudControlClient } =
      await import("../../services/cloudcontrol-client.js");
    const mockSend = vi.fn();
    configureMockSendForS3Success(mockSend, "bp-enforcement-test-bucket");
    vi.mocked(createCloudControlClient).mockReturnValueOnce({
      send: mockSend,
    } as never);

    const config = {
      configurable: { thread_id: "bp-skip-apply-blocking" },
    };
    const graph = createGraph(tools);

    // noWizard defaults to false; non-TTY preserves insecure plan
    await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "skip",
        autoApprove: true,
        noWizard: false,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    const midState = await graph.getState(config);
    const midValues = midState.values as Record<string, unknown>;

    // preflightPassed should be true — skip mode never blocks
    expect(midValues["preflightPassed"]).toBe(true);

    // bp_evaluator still runs (it has no enforcement-level check),
    // so findings are still populated in state with blocking entries
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(midValues["bpFindings"])).toBe(true);
    const findings = midValues["bpFindings"] as Array<{
      blocking: boolean;
      practiceId: string;
    }>;
    expect(findings.length).toBeGreaterThan(0);
    const blockingFindings = findings.filter((f) => f.blocking);
    expect(blockingFindings.length).toBeGreaterThan(0);

    // Graph should be at resource_provisioner interrupt
    expect(midState.next).toContain("resource_provisioner");

    // Phase 2: resume -> provision -> poll -> result
    await graph.invoke(null, config);

    const finalState = await graph.getState(config);
    const finalValues = finalState.values as Record<string, unknown>;

    expect(finalValues["executionStatus"]).toBe(ExecutionStatus.SUCCESS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. enforce + blocking BPs + autoApprove=true → STILL blocked
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — enforce blocks even with autoApprove=true", () => {
  it("--yes flag does NOT bypass enforcement; preflightPassed=false, graph stops at result_formatter", async () => {
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];
    const config = {
      configurable: { thread_id: "bp-enforce-autoapprove-blocked" },
    };
    const graph = createGraph(tools);

    // autoApprove=true (--yes) should NOT bypass BP enforcement.
    // noWizard defaults to false; non-TTY preserves insecure plan.
    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "enforce",
        autoApprove: true,
        noWizard: false,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    // Even with autoApprove=true, enforce mode blocks on blocking findings
    expect(result.preflightPassed).toBe(false);

    // BP findings present with blocking entries
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(result.bpFindings)).toBe(true);
    const blockingFindings = result.bpFindings!.filter(
      (f: { blocking: boolean }) => f.blocking,
    );
    expect(blockingFindings.length).toBeGreaterThan(0);

    // Graph completed (routed to result_formatter -> END), not interrupted
    const graphState = await graph.getState(config);
    expect(graphState.next).toEqual([]);

    // Never reached provisioning
    expect(result.executionStatus).not.toBe(ExecutionStatus.SUCCESS);
    expect(result.executionStatus).not.toBe(ExecutionStatus.IN_PROGRESS);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. enforce + noWizard=true → defaults resolve BPs, enforcement respected
// ═══════════════════════════════════════════════════════════════════════════════

describe("BP enforcement — enforce with noWizard=true (defaults applied)", () => {
  it("noWizard applies security defaults, resolving blocking BPs; enforcement is still active but nothing to block", async () => {
    // noWizard=true causes option_elicitor to apply plugin defaults
    // (BucketEncryption=true, PublicAccessBlock=true, Versioning=true),
    // which resolve most blocking BP findings. This test verifies that:
    // 1. Enforcement level is still "enforce" (not bypassed)
    // 2. The resolved plan passes preflight because defaults satisfy BPs
    // 3. Remaining findings are all non-blocking
    mockLlmForPlanFlow("AWS::S3::Bucket", INSECURE_S3_PLAN);
    const tools = [createS3PricingDispatchTool()];

    // Configure CloudControl for provisioning
    const { createCloudControlClient } =
      await import("../../services/cloudcontrol-client.js");
    const mockSend = vi.fn();
    configureMockSendForS3Success(mockSend, "bp-enforcement-test-bucket");
    vi.mocked(createCloudControlClient).mockReturnValueOnce({
      send: mockSend,
    } as never);

    const config = {
      configurable: { thread_id: "bp-enforce-nowizard-defaults" },
    };
    const graph = createGraph(tools);

    await graph.invoke(
      {
        userIntent: "Create an S3 bucket named bp-enforcement-test-bucket",
        executionMode: ExecutionMode.APPLY,
        bpEnforcementLevel: "enforce",
        autoApprove: true,
        noWizard: true,
        projectDir: "/tmp/nonexistent-project-dir-for-test",
      },
      config,
    );

    const midState = await graph.getState(config);
    const midValues = midState.values as Record<string, unknown>;

    // noWizard defaults resolved blocking BPs, so preflight passes
    expect(midValues["preflightPassed"]).toBe(true);

    // BP findings should still be present (non-blocking advisories remain)
    // Wave 17: strengthened — Array.isArray catches null/undefined AND
    // non-array shapes. Same pattern as bp-evaluator.test.ts.
    expect(Array.isArray(midValues["bpFindings"])).toBe(true);
    const findings = midValues["bpFindings"] as Array<{
      blocking: boolean;
      practiceId: string;
    }>;

    // All remaining findings should be non-blocking (critical ones resolved by defaults)
    const blockingFindings = findings.filter((f) => f.blocking);
    expect(blockingFindings.length).toBe(0);

    // Graph should be at resource_provisioner interrupt (enforcement didn't block)
    expect(midState.next).toContain("resource_provisioner");

    // Phase 2: resume -> provision -> poll -> result
    await graph.invoke(null, config);

    const finalState = await graph.getState(config);
    const finalValues = finalState.values as Record<string, unknown>;

    expect(finalValues["executionStatus"]).toBe(ExecutionStatus.SUCCESS);
  });
});
