/**
 * Tests for wizard-passes.ts (Story 56-it2-03b).
 *
 * Verifies the two key behaviours carried over from the old orchestrator:
 *   1. Quick mode auto-declines the advanced-gate prompt and applies
 *      every showIf-visible advanced field's initialValue as a silent
 *      default (skippedByDefault tally).
 *   2. Non-quick mode asks the user via renderAdvancedConfirm; a "no"
 *      answer still applies the secure defaults; a "yes" answer drops
 *      into the advanced runPromptLoop.
 *
 * Real data: ResourceField shapes match those produced by
 * resource-plugins; stats shape matches runPromptLoop's real return.
 * Mocks are I/O-only (clack prompt and the prompt-loop recursion).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceField, ResolvedFieldConfig } from "@/index.js";
import { FieldPolicy } from "@/constants/field-policy.js";
import type { AgentState } from "../../graph-state.js";

// Mock the advanced-gate confirm (I/O) and runPromptLoop (side-effect
// recursion that we don't re-test here — prompt-loop has its own tests).
const mockRenderAdvancedConfirm = vi.fn();
vi.mock("../../../utils/display.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/display.js")>();
  return {
    ...actual,
    renderAdvancedConfirm: (...args: unknown[]) =>
      mockRenderAdvancedConfirm(...args),
  };
});

const mockRunPromptLoop = vi.fn();
vi.mock("./prompt-loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prompt-loop.js")>();
  return {
    ...actual,
    runPromptLoop: (...args: unknown[]) => mockRunPromptLoop(...args),
  };
});

import { runWizardPasses } from "./wizard-passes.js";

/**
 * Helper: build a realistic common field with a resolved policy entry.
 * The field name shape mirrors what field-preparation produces: a
 * plugin-default resolved value with ASK_IF_NOT_SET policy so the
 * prompt loop will prompt when value is undefined.
 */
function makeCommonField(
  name: string,
  initialValue?: unknown,
): {
  field: ResourceField;
  resolved: ResolvedFieldConfig;
} {
  return {
    field: {
      name,
      question: {
        type: "string",
        label: `Enter ${name}`,
        initialValue,
      },
    },
    resolved: {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    },
  };
}

/**
 * Helper: build a realistic advanced field that has a secure default
 * (initialValue) so the quick-mode skip branch will apply it.
 * When `showIf` is provided, the gate only fires if the dependency
 * matches in elicitedOptions.
 */
function makeAdvancedField(
  name: string,
  initialValue: unknown,
  showIf?: { field: string; value: unknown },
): {
  field: ResourceField;
  resolved: ResolvedFieldConfig;
} {
  return {
    field: {
      name,
      question: {
        type: "string",
        label: `Advanced ${name}`,
        initialValue,
        ...(showIf ? { showIf } : {}),
      },
    },
    resolved: {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    },
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    resourceType: "AWS::S3::Bucket",
    userIntent: "create a bucket",
    runId: "test-run-1",
    ...overrides,
  } as AgentState;
}

describe("runWizardPasses — quickMode = true", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Common-tier runs once; caller mutates elicitedOptions in place.
    mockRunPromptLoop.mockResolvedValueOnce({
      skippedByDefault: 2,
      promptedCount: 1,
    });
  });

  it("auto-declines advanced gate and applies secure defaults for all visible advanced fields", async () => {
    const common = makeCommonField("bucketName");
    const adv1 = makeAdvancedField("versioning", "Enabled");
    const adv2 = makeAdvancedField("encryption", "AES256");
    const elicitedOptions: Record<string, unknown> = {};

    const result = await runWizardPasses(
      {
        commonFields: [common.field],
        advancedFields: [adv1.field, adv2.field],
        resolvedCommon: { bucketName: common.resolved },
        resolvedAdvanced: {
          versioning: adv1.resolved,
          encryption: adv2.resolved,
        },
        elicitedOptions,
        applyPatternHint: (f) => f,
        state: makeState({ quickMode: true } as Partial<AgentState>),
        tools: undefined,
        llmClient: undefined,
      },
      { quickMode: true },
    );

    // Advanced confirm MUST NOT be shown in quick mode.
    expect(mockRenderAdvancedConfirm).not.toHaveBeenCalled();
    // Common tier prompt-loop runs; advanced tier prompt-loop does NOT.
    expect(mockRunPromptLoop).toHaveBeenCalledTimes(1);
    const commonCall = mockRunPromptLoop.mock.calls[0]![0];
    expect(commonCall.quickMode).toBe(true);
    expect(commonCall.progressLabel).toBe("Step");
    // Both visible advanced defaults applied silently.
    expect(elicitedOptions).toEqual({
      versioning: "Enabled",
      encryption: "AES256",
    });
    // Stats: common comes from mocked runPromptLoop; advanced tallies the 2 defaults.
    expect(result.common).toEqual({ skippedByDefault: 2, promptedCount: 1 });
    expect(result.advanced).toEqual({
      skippedByDefault: 2,
      promptedCount: 0,
    });
  });

  it("skips advanced fields whose showIf gate is not satisfied and does not inflate stats", async () => {
    const common = makeCommonField("bucketName");
    const visible = makeAdvancedField("encryption", "AES256");
    const hidden = makeAdvancedField("kmsKeyId", "alias/aws/s3", {
      field: "encryption",
      value: "aws:kms",
    });
    // elicitedOptions does not contain encryption=aws:kms, so hidden stays hidden.
    const elicitedOptions: Record<string, unknown> = {};

    const result = await runWizardPasses(
      {
        commonFields: [common.field],
        advancedFields: [visible.field, hidden.field],
        resolvedCommon: { bucketName: common.resolved },
        resolvedAdvanced: {
          encryption: visible.resolved,
          kmsKeyId: hidden.resolved,
        },
        elicitedOptions,
        applyPatternHint: (f) => f,
        state: makeState({ quickMode: true } as Partial<AgentState>),
        tools: undefined,
        llmClient: undefined,
      },
      { quickMode: true },
    );

    expect(elicitedOptions).toEqual({ encryption: "AES256" });
    expect(elicitedOptions).not.toHaveProperty("kmsKeyId");
    expect(result.advanced.skippedByDefault).toBe(1);
    expect(result.advanced.promptedCount).toBe(0);
  });
});

describe("runWizardPasses — quickMode = false", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunPromptLoop.mockResolvedValueOnce({
      skippedByDefault: 0,
      promptedCount: 3,
    });
  });

  it("asks the advanced gate and runs the advanced prompt-loop when user accepts", async () => {
    mockRenderAdvancedConfirm.mockResolvedValueOnce(true);
    // Second runPromptLoop call = advanced tier.
    mockRunPromptLoop.mockResolvedValueOnce({
      skippedByDefault: 0,
      promptedCount: 2,
    });

    const common = makeCommonField("bucketName");
    const adv = makeAdvancedField("versioning", "Enabled");
    const elicitedOptions: Record<string, unknown> = {};

    const result = await runWizardPasses(
      {
        commonFields: [common.field],
        advancedFields: [adv.field],
        resolvedCommon: { bucketName: common.resolved },
        resolvedAdvanced: { versioning: adv.resolved },
        elicitedOptions,
        applyPatternHint: (f) => f,
        state: makeState(),
        tools: undefined,
        llmClient: undefined,
      },
      { quickMode: false },
    );

    expect(mockRenderAdvancedConfirm).toHaveBeenCalledTimes(1);
    expect(mockRunPromptLoop).toHaveBeenCalledTimes(2);
    const advancedCall = mockRunPromptLoop.mock.calls[1]![0];
    expect(advancedCall.quickMode).toBe(false);
    expect(advancedCall.progressLabel).toBe("Advanced step");
    // User takes over the advanced tier — no silent defaults applied
    // by wizard-passes itself (prompt-loop handles real answers).
    expect(elicitedOptions).toEqual({});
    expect(result.advanced).toEqual({
      skippedByDefault: 0,
      promptedCount: 2,
    });
  });

  it("applies secure defaults (no prompt-loop) when user declines the advanced gate", async () => {
    mockRenderAdvancedConfirm.mockResolvedValueOnce(false);

    const common = makeCommonField("bucketName");
    const adv = makeAdvancedField("versioning", "Enabled");
    const elicitedOptions: Record<string, unknown> = {};

    const result = await runWizardPasses(
      {
        commonFields: [common.field],
        advancedFields: [adv.field],
        resolvedCommon: { bucketName: common.resolved },
        resolvedAdvanced: { versioning: adv.resolved },
        elicitedOptions,
        applyPatternHint: (f) => f,
        state: makeState(),
        tools: undefined,
        llmClient: undefined,
      },
      { quickMode: false },
    );

    expect(mockRenderAdvancedConfirm).toHaveBeenCalledTimes(1);
    // Only common tier runs; advanced tier short-circuits to defaults.
    expect(mockRunPromptLoop).toHaveBeenCalledTimes(1);
    expect(elicitedOptions).toEqual({ versioning: "Enabled" });
    expect(result.advanced).toEqual({
      skippedByDefault: 1,
      promptedCount: 0,
    });
  });
});

describe("runWizardPasses — no advanced fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunPromptLoop.mockResolvedValueOnce({
      skippedByDefault: 0,
      promptedCount: 1,
    });
  });

  it("skips the advanced tier entirely (no gate prompt, no prompt-loop call)", async () => {
    const common = makeCommonField("bucketName");
    const elicitedOptions: Record<string, unknown> = {};

    const result = await runWizardPasses(
      {
        commonFields: [common.field],
        advancedFields: [],
        resolvedCommon: { bucketName: common.resolved },
        resolvedAdvanced: {},
        elicitedOptions,
        applyPatternHint: (f) => f,
        state: makeState(),
        tools: undefined,
        llmClient: undefined,
      },
      { quickMode: false },
    );

    expect(mockRenderAdvancedConfirm).not.toHaveBeenCalled();
    expect(mockRunPromptLoop).toHaveBeenCalledTimes(1);
    expect(result.advanced).toEqual({
      skippedByDefault: 0,
      promptedCount: 0,
    });
    expect(result.common.promptedCount).toBe(1);
  });
});
