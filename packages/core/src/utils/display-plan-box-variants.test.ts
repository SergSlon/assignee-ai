/**
 * Tests for renderPlanBox (unified findings, freeTierNote, BP findings variants),
 * renderDependencyPlan, and renderHitlCompoundConfirm.
 *
 * Split from display.test.ts (W19-S1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ArchitecturePattern,
  ResourceSpec,
} from "../pattern-templates/types.js";
import { captureStream, mockState } from "./__tests__/display-test-utils.js";

// ── renderDependencyPlan fixtures ─────────────────────────────────────────────

const mockPattern: ArchitecturePattern = {
  patternId: "serverless-api",
  displayName: "Serverless API",
  keywords: ["serverless api"],
  resourceList: [
    {
      resourceType: "AWS::IAM::Role",
      resourceId: "iam-role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceType: "AWS::Lambda::Function",
      resourceId: "lambda-fn",
      displayName: "Lambda Function",
    },
    {
      resourceType: "AWS::DynamoDB::Table",
      resourceId: "ddb-table",
      displayName: "DynamoDB Table",
    },
  ],
  dependencyOrder: [["iam-role"], ["lambda-fn", "ddb-table"]],
  defaultOptions: {},
};

const mockResourceQueue: ResourceSpec[] = [
  {
    resourceType: "AWS::IAM::Role",
    resourceId: "iam-role",
    displayName: "Lambda Execution Role",
  },
  {
    resourceType: "AWS::Lambda::Function",
    resourceId: "lambda-fn",
    displayName: "Lambda Function",
  },
  {
    resourceType: "AWS::DynamoDB::Table",
    resourceId: "ddb-table",
    displayName: "DynamoDB Table",
  },
];

// ── Unified findings rendering (Story 18.10) ──────────────────────────────────

describe("renderPlanBox with unified findings — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("shows 'All checks passed' when no findings", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: [] });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
    expect(output).toContain("Findings:");
  });

  it("shows 'All checks passed' when findings is undefined", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: undefined });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
  });

  it("shows blocking and non-blocking findings with plain text markers", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "S3 public access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket has public access enabled",
          blocking: true,
        },
        {
          practiceId: "BP-S3-010",
          title: "S3 lifecycle",
          severity: "MEDIUM",
          category: "cost",
          message: "S3 bucket is missing lifecycle rules",
          blocking: false,
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("1 blocking");
    expect(output).toContain("1 medium");
    expect(output).toContain("[BLOCK] S3 public access");
    expect(output).toContain("[MEDIUM] S3 lifecycle");
    // No ANSI escape codes in non-TTY mode
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("shows correct counts for multiple blocking findings", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "Public access",
          severity: "CRITICAL",
          category: "security",
          message: "Public access issue",
          blocking: true,
        },
        {
          practiceId: "BP-S3-006",
          title: "Encryption",
          severity: "CRITICAL",
          category: "security",
          message: "Encryption issue",
          blocking: true,
        },
        {
          practiceId: "BP-S3-010",
          title: "Lifecycle",
          severity: "MEDIUM",
          category: "cost",
          message: "Lifecycle issue",
          blocking: false,
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("2 blocking");
    expect(output).toContain("1 medium");
  });
});

// ── Free tier note rendering (Story 7.8) ──────────────────────────────────────

describe("renderPlanBox with freeTierNote — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("shows free tier note with checkmark icon for always_free", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      freeTierNote: {
        type: "always_free",
        message: "Always free tier",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Free Tier:");
    expect(output).toContain("✓ Always free tier");
  });

  it("shows free tier note with info icon for legacy_eligible", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      resourceType: "AWS::EC2::Instance",
      freeTierNote: {
        type: "legacy_eligible",
        message: "Free tier: 750 hrs/month t2.micro/t3.micro remaining",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Free Tier:");
    expect(output).toContain("ℹ Free tier: 750 hrs/month");
  });

  it("shows free tier note with info icon for credits_apply", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      resourceType: "AWS::EC2::Instance",
      freeTierNote: {
        type: "credits_apply",
        message: "AWS credits may apply -- check your billing dashboard",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Free Tier:");
    expect(output).toContain("AWS credits may apply");
  });

  it("does not show free tier line when freeTierNote is undefined", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, freeTierNote: undefined });
    restore();

    const output = chunks.join("");
    expect(output).not.toContain("Free Tier:");
  });

  it("includes free tier note as plain text in non-TTY mode (no ANSI)", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      freeTierNote: {
        type: "always_free",
        message: "Always free tier",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Free Tier:");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });
});

// ── Best Practice findings rendering (Story 12.3) ────────────────────────────

describe("renderPlanBox with BP findings — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("shows 'All checks passed' when bpFindings is empty", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: [] });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
    expect(output).toContain("Findings:");
  });

  it("shows 'All checks passed' when bpFindings is undefined", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: undefined });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
  });

  it("shows findings with plain text markers", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "Enable S3 Bucket Versioning",
          severity: "MEDIUM",
          category: "reliability",
          message: "S3 bucket versioning should be enabled",
          remediation: "Set VersioningConfiguration.Status to Enabled",
          blocking: false,
        },
        {
          practiceId: "BP-S3-002",
          title: "Enable S3 Default Encryption",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket should have default encryption",
          remediation: "Configure ServerSideEncryptionConfiguration",
          blocking: false,
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("1 critical");
    expect(output).toContain("1 medium");
    expect(output).toContain("[CRITICAL] Enable S3 Default Encryption");
    expect(output).toContain("[MEDIUM] Enable S3 Bucket Versioning");
    // Remediation hints shown
    expect(output).toContain("Configure ServerSideEncryptionConfiguration");
    // No ANSI escape codes in non-TTY mode
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("maps severity levels correctly", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          practiceId: "BP-S3-010",
          title: "HIGH Finding",
          severity: "HIGH",
          category: "security",
          message: "High severity finding",
          blocking: false,
        },
        {
          practiceId: "BP-S3-011",
          title: "INFO Finding",
          severity: "INFO",
          category: "cost",
          message: "Informational finding",
          blocking: false,
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("[HIGH] HIGH Finding");
    expect(output).toContain("[INFO] INFO Finding");
  });
});

// ── renderDependencyPlan tests ────────────────────────────────────────────────

describe("renderDependencyPlan — non-TTY mode", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("contains pattern display name", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    expect(chunks.join("")).toContain("Serverless API");
  });

  it("contains resource count", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    expect(chunks.join("")).toContain("3");
  });

  it("contains all resource types", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    const output = chunks.join("");
    expect(output).toContain("AWS::IAM::Role");
    expect(output).toContain("AWS::Lambda::Function");
    expect(output).toContain("AWS::DynamoDB::Table");
  });

  it("shows per-resource costs when provided", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue, {
      "iam-role": "Free",
      "lambda-fn": "~$0.20/month",
    });
    restore();
    const output = chunks.join("");
    expect(output).toContain("~$0.20/month");
  });

  it("does not show cost section when perResourceCosts is undefined", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    expect(chunks.join("")).not.toContain("Estimated cost");
  });

  it("does not emit ANSI codes in non-TTY mode", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    expect(chunks.join("")).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("contains region label in non-TTY output", async () => {
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, mockResourceQueue);
    restore();
    expect(chunks.join("")).toContain("Region:");
  });

  it("snapshot: 5-resource non-TTY output", async () => {
    const fiveResourceQueue: ResourceSpec[] = [
      {
        resourceType: "AWS::IAM::Role",
        resourceId: "iam-role",
        displayName: "Lambda Execution Role",
      },
      {
        resourceType: "AWS::Lambda::Function",
        resourceId: "lambda-fn",
        displayName: "Lambda Function",
      },
      {
        resourceType: "AWS::DynamoDB::Table",
        resourceId: "ddb-table",
        displayName: "DynamoDB Table",
      },
      {
        resourceType: "AWS::ApiGateway::RestApi",
        resourceId: "apigw",
        displayName: "API Gateway REST API",
      },
      {
        resourceType: "AWS::CloudWatch::Alarm",
        resourceId: "cw-alarm",
        displayName: "CloudWatch Alarm",
      },
    ];
    const { renderDependencyPlan } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderDependencyPlan(mockPattern, fiveResourceQueue);
    restore();
    expect(chunks.join("")).toMatchSnapshot();
  });
});

// ── renderHitlCompoundConfirm tests ───────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn() },
}));

const { confirm, isCancel } = await import("@clack/prompts");

describe("renderHitlCompoundConfirm — non-TTY mode", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("returns false in non-TTY mode without prompting", async () => {
    const { renderHitlCompoundConfirm } = await import("./display.js");
    const result = await renderHitlCompoundConfirm(mockPattern, 3);
    expect(result).toBe(false);
  });
});

describe("renderHitlCompoundConfirm — TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("calls clack.confirm with compound-specific message", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderHitlCompoundConfirm } = await import("./display.js");
    const result = await renderHitlCompoundConfirm(mockPattern, 3);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Serverless API"),
      }),
    );
    expect(result).toBe(true);
  });

  it("throws UserCancelledError when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderHitlCompoundConfirm } = await import("./display.js");
    await expect(renderHitlCompoundConfirm(mockPattern, 3)).rejects.toThrow(
      "Operation cancelled by user.",
    );
  });
});
