/**
 * Tests for display.ts (Story 1-8, AC10).
 * Verifies plan box format, error format, and non-TTY plain-text fallback.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceField, ResolvedFieldConfig } from "@assignee/core";

// Capture stdout/stderr writes
function captureStream(stream: NodeJS.WriteStream) {
  const chunks: string[] = [];
  const original = stream.write.bind(stream);
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation((chunk: unknown, ...args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, spy, restore: () => spy.mockRestore() };
}

const mockState = {
  resourceType: "AWS::S3::Bucket",
  desiredState: { BucketName: "my-test-bucket" },
  estimatedMonthlyCost: "~$0.02/month",
  runId: "run-display-test-123",
  resourceArn: undefined,
  executionMode: "plan",
};

describe("display.ts — non-TTY (CI) mode", () => {
  beforeEach(() => {
    // Force non-TTY mode
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore TTY to undefined (default in test env)
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("renderPlanBox writes plain text without ANSI codes", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).toContain("AWS::S3::Bucket");
    expect(output).toContain("my-test-bucket");
    expect(output).toContain("~$0.02/month");
    // Run ID is hidden unless verbose is set (Story 18.11)
    // No ANSI escape codes
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("renderPlanBox includes Resource Type, Region, Config, Estimated Cost fields", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).toContain("Resource Type");
    expect(output).toContain("Region");
    expect(output).toContain("Config");
    expect(output).toContain("Estimated Cost");
  });

  it("renderPlanBox hides Run ID unless verbose is set", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).not.toContain("Run ID");
  });

  it("renderPlanBox shows Run ID when verbose is true", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, verbose: true });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Run ID");
  });

  it("renderError writes plain text without ANSI codes", async () => {
    const { renderError } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stderr);

    renderError("Something went wrong", "Check your credentials");
    restore();

    const output = chunks.join("");
    expect(output).toContain("Something went wrong");
    expect(output).toContain("Check your credentials");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it('renderError includes "Supported types" text for unsupported resource hint', async () => {
    const { renderError } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stderr);

    renderError(
      "Unsupported resource type",
      "Supported types: AWS::S3::Bucket, AWS::EC2::Instance",
    );
    restore();

    const output = chunks.join("");
    expect(output).toContain("Supported types:");
    expect(output).toContain("AWS::S3::Bucket");
  });

  it("renderApplySuccess writes ARN and RunID in plain text", async () => {
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess({
      ...mockState,
      resourceArn: "arn:aws:s3:::my-test-bucket",
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("arn:aws:s3:::my-test-bucket");
    expect(output).toContain("run-display-test-123");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  // Wave 11 P2-6 / test-arch F5: renderApplySuccess(state, displayArn?)
  // gained an explicit displayArn parameter in Wave 8 (BUG-5 / V6 P0
  // fix). Existing tests still call the legacy 1-arg form, so the new
  // explicit-takes-precedence branch was uncovered. Pin the contract:
  // when displayArn is passed, it MUST be shown instead of
  // state.resourceArn — that's how result-formatter.ts surfaces the
  // resolved full ARN while keeping state.resourceArn as the bare
  // CCAPI primary identifier (the V6 P0 invariant).
  it("renderApplySuccess prefers the explicit displayArn over state.resourceArn", async () => {
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess(
      {
        ...mockState,
        // BARE CCAPI primary identifier (the V6 P0 invariant — never mutate this)
        resourceArn: "my-test-bucket",
      },
      // Explicit full ARN passed by result-formatter.ts after STS lookup
      "arn:aws:s3:::my-test-bucket",
    );
    restore();

    const output = chunks.join("");
    // Explicit displayArn appears
    expect(output).toContain("arn:aws:s3:::my-test-bucket");
    // The bare identifier from state.resourceArn must NOT appear as the
    // ARN line — it would be misleading and the whole point of the
    // displayArn parameter is to suppress this exact case.
    expect(output).toMatch(/ARN:\s*arn:aws:s3:::my-test-bucket/);
  });

  it("renderApplySuccess falls back to state.resourceArn when displayArn is undefined", async () => {
    // The legacy 1-arg form still works (the helper is backwards
    // compatible). When STS lookup fails and result-formatter falls
    // back to passing only state, the bare identifier is what the
    // user sees.
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess({
      ...mockState,
      resourceArn: "fallback-bucket-name",
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("fallback-bucket-name");
  });

  it("renderOutro writes success message in plain text", async () => {
    const { renderOutro } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderOutro(true);
    restore();

    const output = chunks.join("");
    expect(output).toContain("completed successfully");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("renderOutro writes failure message in plain text", async () => {
    const { renderOutro } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderOutro(false);
    restore();

    const output = chunks.join("");
    expect(output).toContain("failed");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });
});

it("renderCompoundSuccess writes all resource types and pattern name in plain text", async () => {
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        resourceId: "lambda-execution-role",
        resourceType: "AWS::IAM::Role",
        resourceArn: "arn:aws:iam::123:role/exec-role",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "lambda-fn",
        resourceType: "AWS::Lambda::Function",
        resourceArn: "arn:aws:lambda::123:function:my-fn",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "serverless-api",
      displayName: "Serverless API",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
  );
  restore();

  const output = chunks.join("");
  expect(output).toContain("Serverless API");
  expect(output).toContain("AWS::IAM::Role");
  expect(output).toContain("AWS::Lambda::Function");
  expect(output).toContain("arn:aws:iam::123:role/exec-role");
  expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
});

// Wave 11 P2-6 / test-arch F6: renderCompoundSuccess gained an
// optional `displayArns` parameter (Map<resourceId, fullArn>) in
// Wave 8 so the compound apply success line shows full ARNs without
// mutating state.resourceArn (the V6 P0 invariant). Pin the contract.
it("renderCompoundSuccess prefers explicit displayArns map over each resource's bare resourceArn", async () => {
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        // BARE CCAPI identifiers (V6 P0 invariant — these are what the
        // marker resolver substitutes into child fields)
        resourceId: "vpc-1",
        resourceType: "AWS::EC2::VPC",
        resourceArn: "vpc-0123456789abcdef0",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "subnet-1",
        resourceType: "AWS::EC2::Subnet",
        resourceArn: "subnet-0123456789abcdef0",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "minimal-vpc",
      displayName: "Minimal VPC",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
    // Explicit display map keyed by resourceId — what result-formatter
    // builds after STS lookup
    {
      "vpc-1": "arn:aws:ec2:us-east-1:112233445566:vpc/vpc-0123456789abcdef0",
      "subnet-1":
        "arn:aws:ec2:us-east-1:112233445566:subnet/subnet-0123456789abcdef0",
    },
  );
  restore();

  const output = chunks.join("");
  // The full ARNs from displayArns appear, not the bare identifiers
  expect(output).toContain(
    "arn:aws:ec2:us-east-1:112233445566:vpc/vpc-0123456789abcdef0",
  );
  expect(output).toContain(
    "arn:aws:ec2:us-east-1:112233445566:subnet/subnet-0123456789abcdef0",
  );
});

it("renderCompoundSuccess falls back to resource.resourceArn when displayArns map lacks the entry", async () => {
  // Partial coverage: STS may have resolved the first resource but
  // not the second (rare, but possible when CCAPI returns mixed
  // identifier shapes). Each resource falls back independently.
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        resourceId: "resolved",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "my-bucket",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "unresolved",
        resourceType: "AWS::Lambda::Function",
        resourceArn: "my-fn-bare-fallback",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "p",
      displayName: "Test",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
    {
      // Only `resolved` got a full ARN — `unresolved` is missing
      resolved: "arn:aws:s3:::my-bucket",
    },
  );
  restore();

  const output = chunks.join("");
  expect(output).toContain("arn:aws:s3:::my-bucket");
  // The unresolved one falls back to its bare identifier
  expect(output).toContain("my-fn-bare-fallback");
});

// ── renderDependencyPlan tests ────────────────────────────────────────────────

import type { ArchitecturePattern, ResourceSpec } from "@assignee/core";

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

// ── renderOptionPrompt tests ──────────────────────────────────────────────────

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

const { confirm, select, text, multiselect, isCancel, note, log } =
  await import("@clack/prompts");

function makeField(
  overrides: Partial<ResourceField["question"]> & { name?: string } = {},
): ResourceField {
  const { name = "TestField", ...q } = overrides;
  return {
    name,
    question: {
      type: "string",
      label: "Test label",
      ...q,
    },
  };
}

const resolved: ResolvedFieldConfig = {
  policy: "ask_if_not_set",
  value: undefined,
  source: "plugin_default",
};

describe("renderOptionPrompt — TTY mode", () => {
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

  it("calls clack.text for string type", async () => {
    vi.mocked(text).mockResolvedValueOnce("hello");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "string" }),
      resolved,
    );
    expect(text).toHaveBeenCalledOnce();
    expect(result).toBe("hello");
  });

  it("calls clack.confirm for boolean type", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enable?" }),
    );
    expect(result).toBe(true);
  });

  it("calls clack.select for enum type", async () => {
    vi.mocked(select).mockResolvedValueOnce("opt-a");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({
        type: "enum",
        options: [{ value: "opt-a", label: "Option A" }],
      }),
      resolved,
    );
    expect(select).toHaveBeenCalledOnce();
    expect(result).toBe("opt-a");
  });

  it("calls clack.multiselect for multi type", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce(["a", "b"]);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "multi", options: [{ value: "a", label: "A" }] }),
      resolved,
    );
    expect(multiselect).toHaveBeenCalledOnce();
    expect(result).toEqual(["a", "b"]);
  });

  it("returns undefined for multi type with empty options (no crash)", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "multi", options: [] }),
      resolved,
    );
    expect(multiselect).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("throws UserCancelledError when clack.isCancel returns true", async () => {
    vi.mocked(text).mockResolvedValueOnce(
      Symbol("cancel") as unknown as string,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    await expect(
      renderOptionPrompt(makeField({ type: "string" }), {
        ...resolved,
        value: "fallback",
      }),
    ).rejects.toThrow("Operation cancelled by user.");
  });
});

describe("renderOptionPrompt — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns resolved.value without prompting", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(makeField({ type: "string" }), {
      ...resolved,
      value: "preset",
    });
    expect(text).not.toHaveBeenCalled();
    expect(result).toBe("preset");
  });

  it("returns field initialValue when resolved.value is undefined", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", initialValue: true }),
      resolved,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

// ── renderDocHelp tests (Story 7.5) ───────────────────────────────────────────

import type { StructuredTool } from "@langchain/core/tools";

function makeTool(
  name: string,
  invokeFn: () => Promise<unknown>,
): StructuredTool {
  // Each test creates a fresh tool via this helper, and some tests assert
  // on `.toHaveBeenCalledOnce()`, so we need a real `vi.fn()`. Pass the
  // implementation directly to the constructor (vi.fn(impl)) — this binds
  // the implementation as the default that survives intra-test usage.
  return {
    name,
    description: "",
    invoke: vi.fn(invokeFn),
  } as unknown as StructuredTool;
}

describe("renderDocHelp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows fallback when search tool not in tools array and returns null", async () => {
    const { renderDocHelp } = await import("./display.js");

    const result = await renderDocHelp("BucketName", "AWS::S3::Bucket", []);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
    );
    expect(result).toBeNull();
  });

  it("shows fallback when search tool times out (returns null via race) and returns null", async () => {
    // Search tool never resolves — timeout wins
    const searchTool = makeTool(
      "search_documentation",
      () => new Promise(() => {}),
    );
    const readTool = makeTool("read_sections", () => Promise.resolve("text"));

    // Use fake timers to trigger the 2s timeout immediately
    vi.useFakeTimers();
    const { renderDocHelp } = await import("./display.js");
    const promise = renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);
    await vi.advanceTimersByTimeAsync(16000);
    const result = await promise;
    vi.useRealTimers();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
    expect(result).toBeNull();
  }, 12_000);

  it("shows fallback when search returns no URL", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve("No results found."),
    );
    const readTool = makeTool("read_sections", () => Promise.resolve("text"));

    const { renderDocHelp } = await import("./display.js");
    await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("No documentation page found"),
    );
  });

  it("calls clack.note with description when search + read succeed and returns hint text", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    const readTool = makeTool("read_sections", () =>
      Promise.resolve(
        "The BucketName property specifies the name of the S3 bucket.",
      ),
    );

    const { renderDocHelp } = await import("./display.js");
    const result = await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
      expect.stringContaining("📖 BucketName"),
    );
    expect(result).toEqual(
      expect.stringContaining("BucketName property specifies"),
    );
  });

  it("shows fallback when read_sections times out", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    // read_sections never resolves
    const readTool = makeTool("read_sections", () => new Promise(() => {}));

    vi.useFakeTimers();
    const { renderDocHelp } = await import("./display.js");
    const promise = renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);
    // advanceTimersByTimeAsync flushes pending microtasks between steps,
    // allowing the search result to resolve before the read timeout fires
    await vi.advanceTimersByTimeAsync(16000);
    await promise;
    vi.useRealTimers();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("unreachable"),
    );
  }, 12_000);

  it("falls back to read_documentation when read_sections throws No matching sections", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    const readTool = makeTool("read_sections", () =>
      Promise.reject(new Error("No matching sections were found")),
    );
    const readDocTool = makeTool("read_documentation", () =>
      Promise.resolve("Full page content fallback"),
    );

    const { renderDocHelp } = await import("./display.js");
    await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
      readDocTool,
    ]);

    expect(readDocTool.invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("Full page content fallback"),
      expect.stringContaining("📖 BucketName"),
    );
  });

  // ── Story 7.9: LLM synthesis tests ──────────────────────────────────────────

  describe("with llmClient", () => {
    const makeDocTools = () => ({
      searchTool: makeTool("search_documentation", () =>
        Promise.resolve(
          "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for more",
        ),
      ),
      readTool: makeTool("read_sections", () =>
        Promise.resolve(
          "BucketName specifies the raw CloudFormation property syntax for S3...",
        ),
      ),
    });

    it("calls generateText and displays synthesized hint when LLM succeeds, returns hint text", async () => {
      const { searchTool, readTool } = makeDocTools();
      const llmClient = {
        generateText: vi
          .fn()
          .mockResolvedValue([
            null,
            "BucketName is the globally unique S3 bucket identifier. It must be 3-63 lowercase characters. Choose a name like `my-company-logs`.",
          ] as const),
        generateStructured: vi.fn(),
      };

      const { renderDocHelp } = await import("./display.js");
      const result = await renderDocHelp(
        "BucketName",
        "AWS::S3::Bucket",
        [searchTool, readTool],
        llmClient,
      );

      expect(llmClient.generateText).toHaveBeenCalledOnce();
      expect(llmClient.generateText).toHaveBeenCalledWith(
        expect.stringContaining("BucketName"),
      );
      expect(vi.mocked(note)).toHaveBeenCalledWith(
        expect.stringContaining("globally unique"),
        expect.stringContaining("📖 BucketName"),
      );
      expect(result).toEqual(expect.stringContaining("globally unique"));
    });

    it("falls back to raw doc text when generateText returns an error", async () => {
      const { searchTool, readTool } = makeDocTools();
      const llmClient = {
        generateText: vi
          .fn()
          .mockResolvedValue([new Error("Bedrock throttled"), null] as const),
        generateStructured: vi.fn(),
      };

      const { renderDocHelp } = await import("./display.js");
      await renderDocHelp(
        "BucketName",
        "AWS::S3::Bucket",
        [searchTool, readTool],
        llmClient,
      );

      expect(llmClient.generateText).toHaveBeenCalledOnce();
      // Falls back — clack.note called with the raw unwrapped doc text, not synthesized text
      expect(vi.mocked(note)).toHaveBeenCalledWith(
        expect.stringContaining("BucketName specifies"),
        expect.stringContaining("📖 BucketName"),
      );
    });
  });
});

// ── Unified findings rendering (Story 18.10) ────────────────────────────────

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
    expect(output).toContain("\u2713 Always free tier");
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
    expect(output).toContain("\u2139 Free tier: 750 hrs/month");
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

// ── Story 19.2: renderSecurityWarnings ─────────────────────────────────────

describe("renderSecurityWarnings", () => {
  let writeSpy: any;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders CRITICAL finding with red indicator", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::my-bucket", [
      {
        severity: "CRITICAL",
        title: "S3 bucket has public read access",
        recommendation: "Block public access",
        service: "SecurityHub",
      },
    ]);

    const allOutput = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(allOutput).toContain("Security findings for arn:aws:s3:::my-bucket");
    expect(allOutput).toContain("[CRITICAL] S3 bucket has public read access");
    expect(allOutput).toContain("Block public access");
  });

  it("renders multiple findings with recommendations", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::test-bucket", [
      {
        severity: "CRITICAL",
        title: "Public access enabled",
        recommendation: "Disable public access",
        service: "SecurityHub",
      },
      {
        severity: "HIGH",
        title: "No encryption",
        recommendation: "Enable SSE-S3",
        service: "SecurityHub",
      },
    ]);

    const allOutput = writeSpy.mock.calls.map((c: any[]) => c[0]).join("");
    expect(allOutput).toContain("[CRITICAL] Public access enabled");
    expect(allOutput).toContain("[HIGH] No encryption");
    expect(allOutput).toContain("Disable public access");
    expect(allOutput).toContain("Enable SSE-S3");
  });

  it("does nothing when findings array is empty", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::my-bucket", []);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ── renderTradeoffHelp tests (Story 10.6) ─────────────────────────────────────

describe("renderTradeoffHelp", () => {
  const testOptions = [
    { value: "t3.micro", label: "t3.micro — 2 vCPU, 1 GiB" },
    { value: "t3.small", label: "t3.small — 2 vCPU, 2 GiB" },
    { value: "m5.large", label: "m5.large — 2 vCPU, 8 GiB" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateText and displays trade-off in clack.note on success, returns trimmed text", async () => {
    const llmClient = {
      generateText: vi
        .fn()
        .mockResolvedValue([
          null,
          "t3.micro: ~$8/mo, best for light workloads.\nt3.small: ~$15/mo, best for moderate traffic.\nRecommendation: t3.micro for a low-traffic blog.",
        ] as const),
      generateStructured: vi.fn(),
    };

    const { renderTradeoffHelp } = await import("./display.js");
    const result = await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );

    expect(llmClient.generateText).toHaveBeenCalledOnce();
    expect(llmClient.generateText).toHaveBeenCalledWith(
      expect.stringContaining("low-traffic blog"),
    );
    expect(llmClient.generateText).toHaveBeenCalledWith(
      expect.stringContaining("InstanceType"),
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("t3.micro"),
      expect.stringContaining("⚖️ InstanceType — Trade-off Analysis"),
    );
    expect(result).toEqual(expect.stringContaining("t3.micro"));
  });

  it("falls back to renderDocHelp when LLM times out (returns null)", async () => {
    // Simulate timeout: generateText never resolves within the timeout.
    // Plain function so vitest mockReset cannot strip the never-resolving body.
    const llmClient = {
      generateText: () => new Promise<never>(() => {}),
      generateStructured: vi.fn(),
    };

    vi.useFakeTimers();
    const { renderTradeoffHelp } = await import("./display.js");
    const promise = renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;
    vi.useRealTimers();

    // Should NOT have called clack.note with trade-off title
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  }, 15_000);

  it("falls back to renderDocHelp when llmClient is undefined", async () => {
    const { renderTradeoffHelp } = await import("./display.js");
    await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      undefined,
    );

    // Should not render trade-off note (no llmClient → fallback path)
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  });

  it("falls back to renderDocHelp when generateText returns an error", async () => {
    const llmClient = {
      generateText: vi
        .fn()
        .mockResolvedValue([new Error("Bedrock throttled"), null] as const),
      generateStructured: vi.fn(),
    };

    const { renderTradeoffHelp } = await import("./display.js");
    await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );

    expect(llmClient.generateText).toHaveBeenCalledOnce();
    // Should not render trade-off note (error → fallback path)
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  });
});

// ── Story 9.9: Additional display tests for coverage gaps ─────────────────

describe("formatFindings — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("empty findings → 'All checks passed'", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([]);
    expect(result).toContain("PASS All checks passed");
  });

  it("undefined findings → 'All checks passed'", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings(undefined);
    expect(result).toContain("PASS All checks passed");
  });

  it("blocking finding → [BLOCK] marker in output", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        ruleId: "r1",
        severity: "CRITICAL",
        message: "Encryption missing",
        blocking: true,
      },
    ] as any);
    expect(result).toContain("[BLOCK]");
    expect(result).toContain("1 blocking");
  });

  it("mixed severities → correct counts in summary", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        ruleId: "r1",
        severity: "CRITICAL",
        message: "Critical issue",
        blocking: false,
      },
      {
        ruleId: "r2",
        severity: "HIGH",
        message: "High issue",
        blocking: false,
      },
      {
        ruleId: "r3",
        severity: "MEDIUM",
        message: "Medium issue",
        blocking: false,
      },
      {
        ruleId: "r4",
        severity: "INFO",
        message: "Info note",
        blocking: false,
      },
    ] as any);
    expect(result).toContain("1 critical");
    expect(result).toContain("1 high");
    expect(result).toContain("1 medium");
    expect(result).toContain("1 info");
    expect(result).toContain("[CRITICAL]");
    expect(result).toContain("[HIGH]");
    expect(result).toContain("[MEDIUM]");
    expect(result).toContain("[INFO]");
  });

  it("finding with remediation hint included in output", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        ruleId: "r1",
        severity: "HIGH",
        message: "Public access enabled",
        remediation: "Set BlockPublicAccess to true",
        blocking: false,
      },
    ] as any);
    expect(result).toContain("Set BlockPublicAccess to true");
  });
});

describe("renderPlanBox — with BP findings", () => {
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

  it("includes findings in plan box output", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          ruleId: "r1",
          severity: "CRITICAL",
          message: "Encryption not enabled",
          blocking: false,
        },
      ] as any,
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("[CRITICAL]");
    expect(output).toContain("1 critical");
  });

  it("includes free tier note in plan box", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      freeTierNote: {
        type: "always_free",
        message: "IAM is always free",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("IAM is always free");
    expect(output).toContain("Free Tier");
  });

  it("includes memory hints in plan box", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      memoryHints: ["Last deployed: $0.50/mo avg"],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Last deployed: $0.50/mo avg");
    expect(output).toContain("Cost History");
  });
});

describe("renderHitlConfirm — TTY mode", () => {
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

  it("user approves — returns true", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(true);
  });

  it("user rejects — returns false", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
  });

  it("throws UserCancelledError when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    await expect(renderHitlConfirm(mockState)).rejects.toThrow(
      "Operation cancelled by user.",
    );
  });
});

describe("renderHitlConfirm — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns false without prompting", async () => {
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("renderApplyNowConfirm — TTY mode", () => {
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

  it("user approves — returns true", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderApplyNowConfirm } = await import("./display.js");
    const result = await renderApplyNowConfirm(mockState);
    expect(result).toBe(true);
  });

  it("user rejects — returns false", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderApplyNowConfirm } = await import("./display.js");
    const result = await renderApplyNowConfirm(mockState);
    expect(result).toBe(false);
  });

  it("throws UserCancelledError when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderApplyNowConfirm } = await import("./display.js");
    await expect(renderApplyNowConfirm(mockState)).rejects.toThrow(
      "Operation cancelled by user.",
    );
  });
});

describe("renderApplyNowConfirm — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns false without prompting", async () => {
    const { renderApplyNowConfirm } = await import("./display.js");
    const result = await renderApplyNowConfirm(mockState);
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("renderSecurityWarnings", () => {
  it("no findings — no output", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as any);
    const { renderSecurityWarnings } = await import("./display.js");
    renderSecurityWarnings("arn:aws:s3:::test", []);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("CRITICAL + HIGH findings — shows both with icons", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as any);
    const { renderSecurityWarnings } = await import("./display.js");
    renderSecurityWarnings("arn:aws:s3:::test", [
      {
        severity: "CRITICAL",
        title: "Public bucket",
        recommendation: "Block public access",
        service: "s3",
      },
      {
        severity: "HIGH",
        title: "No encryption",
        recommendation: "Enable SSE",
        service: "s3",
      },
    ]);
    const output = stdoutSpy.mock.calls
      .map((c: any[]) => String(c[0]))
      .join("");
    expect(output).toContain("Public bucket");
    expect(output).toContain("No encryption");
    expect(output).toContain("Block public access");
    stdoutSpy.mockRestore();
  });
});

describe("spinner functions", () => {
  it("startSpinner non-TTY — writes label to stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { startSpinner } = await import("./display.js");
    startSpinner("Loading...");
    expect(writeSpy).toHaveBeenCalledWith("Loading......\n");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("updateSpinner non-TTY — writes label to stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { updateSpinner } = await import("./display.js");
    updateSpinner("Still loading...");
    expect(writeSpy).toHaveBeenCalledWith("Still loading......\n");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderAdvancedConfirm", () => {
  it("non-TTY — returns false", async () => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    const { renderAdvancedConfirm } = await import("./display.js");
    const result = await renderAdvancedConfirm();
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("TTY approve — returns true", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderAdvancedConfirm } = await import("./display.js");
    const result = await renderAdvancedConfirm();
    expect(result).toBe(true);
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("TTY cancel — throws UserCancelledError", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderAdvancedConfirm } = await import("./display.js");
    await expect(renderAdvancedConfirm()).rejects.toThrow(
      "Operation cancelled by user.",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderError — structured format", () => {
  it("includes why context when provided", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    renderError("Something failed", "Check logs", { why: "Network timeout" });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[CONTEXT] Network timeout");
    expect(output).toContain("[FIX] Check logs");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderResourceTable — non-TTY", () => {
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

  it("renders tab-separated rows", async () => {
    const { renderResourceTable } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);
    renderResourceTable([
      {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::test",
        region: "us-east-1",
        createdDate: "2024-01-01",
        estimatedMonthlyCost: "$0.02",
      },
    ]);
    restore();
    const output = chunks.join("");
    expect(output).toContain("AWS::S3::Bucket\t");
    expect(output).toContain("arn:aws:s3:::test");
    expect(output).toContain("us-east-1");
  });
});

describe("renderEmptyList — non-TTY", () => {
  it("renders hint message", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderEmptyList } = await import("./display.js");
    renderEmptyList();
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("No resources managed");
    expect(output).toContain("assignee apply");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderStatusSummary — non-TTY", () => {
  it("renders plain text summary", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderStatusSummary } = await import("./display.js");
    renderStatusSummary({
      totalResources: 3,
      totalEstimatedMonthlyCost: "$5.00",
      byType: [
        { type: "AWS::S3::Bucket", count: 2, estimatedMonthlyCost: "$1.00" },
      ],
      byRegion: [
        { region: "us-east-1", count: 3, estimatedMonthlyCost: "$5.00" },
      ],
      lastUpdated: new Date().toISOString(),
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("Total Resources: 3");
    expect(output).toContain("AWS::S3::Bucket");
    expect(output).toContain("us-east-1");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderEmptyStatus — non-TTY", () => {
  it("renders hint message", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderEmptyStatus } = await import("./display.js");
    renderEmptyStatus();
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("No resources managed");
    expect(output).toContain("assignee plan");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderOptionPrompt — edge cases", () => {
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

  it("boolean field — false (via clack.confirm)", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(result).toBe(false);
  });

  it("boolean field — true (via clack.confirm)", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(result).toBe(true);
  });

  it("string field — empty string returns undefined (skipped)", async () => {
    vi.mocked(text).mockResolvedValueOnce("  ");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "string" }),
      resolved,
    );
    expect(result).toBeUndefined();
  });

  it("field with hint — clack.note called before prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(text).mockResolvedValueOnce("value");
    const { renderOptionPrompt } = await import("./display.js");
    await renderOptionPrompt(
      makeField({ type: "string", hint: "Contextual hint" }),
      resolved,
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      "Contextual hint",
      "TestField",
    );
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── Story 18.11: formatDesiredState tests ─────────────────────────────────

describe("formatDesiredState", () => {
  let formatDesiredState: typeof import("./display.js").formatDesiredState;

  beforeEach(async () => {
    const display = await import("./display.js");
    formatDesiredState = display.formatDesiredState;
  });

  it("maps known keys to friendly names", () => {
    const result = formatDesiredState({ InstanceType: "t3.micro" });
    expect(result).toContain("Instance Type");
    expect(result).toContain("t3.micro");
  });

  it("falls back to spaced PascalCase for unknown keys", () => {
    const result = formatDesiredState({ SomeCustomProperty: "my-value" });
    expect(result).toContain("Some Custom Property");
    expect(result).toContain("my-value");
  });

  it("renders booleans as Yes/No", () => {
    const result = formatDesiredState({ MultiAZ: true });
    expect(result).toContain("Yes");
  });

  it("renders false booleans as No", () => {
    const result = formatDesiredState({ MultiAZ: false });
    expect(result).toContain("No");
  });

  it("joins arrays with commas", () => {
    const result = formatDesiredState({
      SecurityGroupIds: ["sg-123", "sg-456"],
    });
    expect(result).toContain("sg-123, sg-456");
  });

  it("renders Tag arrays as Key:Value pairs", () => {
    const result = formatDesiredState({
      Tags: [
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ],
    });
    expect(result).toContain("env:prod, team:backend");
  });

  it("returns (none) for empty state", () => {
    const result = formatDesiredState({});
    expect(result).toBe("(none)");
  });

  it("handles nested objects — S3 encryption shows friendly format", () => {
    const result = formatDesiredState({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: "AES256",
      },
    });
    expect(result).toContain("AES-256 (SSE-S3) enabled");
  });
});

// ── P0-1 regression: resource-type-scoped label resolution ─────────────────
//
// Bug: FRIENDLY_NAMES was a flat Record<string, string>, so
// `[CfnKey.TYPE]: "Load Balancer Type"` (intended for ELBv2) was applied to
// EVERY resource whose CFN schema has a top-level `Type` property — SSM
// Parameter, CloudWatch Alarm, DynamoDB (free-form) — producing "Load Balancer
// Type   String" in SSM plans. Fix: per-resource overrides via
// FRIENDLY_NAMES_BY_TYPE + resourceType arg to formatDesiredState.
describe("formatDesiredState — per-resource-type label resolution (P0-1)", () => {
  let formatDesiredState: typeof import("./display.js").formatDesiredState;
  let RESOURCE_TYPES: typeof import("@assignee/core").RESOURCE_TYPES;

  beforeEach(async () => {
    const display = await import("./display.js");
    formatDesiredState = display.formatDesiredState;
    const core = await import("@assignee/core");
    RESOURCE_TYPES = core.RESOURCE_TYPES;
  });

  it("SSM Parameter: Type renders as 'Parameter Type', not 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::SSM::Parameter
    const result = formatDesiredState(
      {
        Name: "/my-app/config/db-host",
        Type: "String",
        Value: "db.example.com",
        Description: "Database host",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("String");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("SSM Parameter: SecureString Type renders as 'Parameter Type'", () => {
    const result = formatDesiredState(
      {
        Name: "/prod/db/password",
        Type: "SecureString",
        Value: "s3cr3t",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("SecureString");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("SSM Parameter: StringList Type renders as 'Parameter Type'", () => {
    const result = formatDesiredState(
      {
        Name: "/app/allowed-origins",
        Type: "StringList",
        Value: "https://a.com,https://b.com",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("StringList");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("ELBv2 LoadBalancer: Type renders as 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::ElasticLoadBalancingV2::LoadBalancer
    const result = formatDesiredState(
      {
        Name: "my-alb",
        Type: "application",
        Scheme: "internet-facing",
        Subnets: ["subnet-abc", "subnet-def"],
      },
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(result).toContain("Load Balancer Type");
    expect(result).toContain("application");
  });

  it("ELBv2 LoadBalancer: network type renders as 'Load Balancer Type'", () => {
    const result = formatDesiredState(
      {
        Name: "my-nlb",
        Type: "network",
        Scheme: "internal",
      },
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(result).toContain("Load Balancer Type");
    expect(result).toContain("network");
  });

  it("DynamoDB Table: KeySchema renders without 'Load Balancer Type' for nested KeyType", () => {
    // Real CFN shape for AWS::DynamoDB::Table — KeySchema is nested, the
    // nested KeyType field must NOT be relabeled globally.
    const result = formatDesiredState(
      {
        TableName: "my-table",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      },
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    expect(result).toContain("Table Name");
    expect(result).toContain("my-table");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("DynamoDB Table: free-form top-level Type never leaks 'Load Balancer Type'", () => {
    // Defensive — if anything ever places a top-level Type on DynamoDB, we
    // must NOT reuse the ELBv2 label.
    const result = formatDesiredState(
      {
        TableName: "my-table",
        Type: "GlobalTable",
      },
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("GlobalTable");
  });

  it("CloudWatch Alarm: top-level Type renders as 'Alarm Type', not 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::CloudWatch::Alarm (plus synthetic Type field —
    // some composite alarm forms surface Type, and we must never mislabel it)
    const result = formatDesiredState(
      {
        AlarmName: "high-cpu",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Type: "MetricAlarm",
        Threshold: 80,
        ComparisonOperator: "GreaterThanThreshold",
      },
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(result).toContain("Alarm Type");
    expect(result).toContain("MetricAlarm");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("ELBv2 TargetGroup: no plugin override defined — Type falls back to spacePascalCase, NOT 'Load Balancer Type'", () => {
    // AWS::ElasticLoadBalancingV2::TargetGroup has no plugin yet, but may be
    // surfaced via generic plan rendering. The fix removes the global
    // [CfnKey.TYPE] entry so unknown resource types fall back safely.
    const result = formatDesiredState(
      {
        Name: "my-tg",
        Port: 443,
        Protocol: "HTTPS",
        TargetType: "instance",
        VpcId: "vpc-abc",
      },
      "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
    // Port/Protocol/VpcId still resolve via the global map
    expect(result).toContain("VPC");
    // TargetType is not in the global map — falls back to spacePascalCase
    expect(result).toContain("Target Type");
    expect(result).toContain("instance");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("unknown resource type: top-level Type falls back to spacePascalCase, never 'Load Balancer Type'", () => {
    // Defensive fallback — passing an unknown resourceType must never resurface the old bug.
    const result = formatDesiredState(
      { Type: "SomeValue", Name: "x" },
      "AWS::Some::NewResource",
    );
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("SomeValue");
  });

  it("no resource type passed: preserves legacy behavior for global-only labels", () => {
    // Backward compatibility — callers that don't pass a resourceType still
    // get sensible labels for unambiguous fields.
    const result = formatDesiredState({
      InstanceType: "t3.micro",
      BucketName: "my-bucket",
    });
    expect(result).toContain("Instance Type");
    expect(result).toContain("Bucket Name");
  });

  it("no resource type passed: top-level Type no longer mislabels as 'Load Balancer Type'", () => {
    // This is the raw reproduction from the bug report — no resourceType
    // supplied, just a desiredState with a Type field. It must fall back to
    // spacePascalCase, never the old ELBv2 label.
    const result = formatDesiredState({ Name: "/test", Type: "String" });
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("String");
  });
});

// ── renderOptionPrompt — categorySelect tests (Story 18.12) ─────────────────

describe("renderOptionPrompt — categorySelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
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

  const categoryField: ResourceField = {
    name: "InstanceType",
    question: {
      type: "categorySelect",
      label: "Instance type",
      initialValue: "t3.micro",
      categories: [
        {
          key: "burstable",
          label: "Burstable (t3/t4g) — $0.008-0.17/hr",
          description: "Variable CPU with burst credits.",
          options: [
            { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB)" },
            {
              value: "t3.small",
              label: "t3.small (2 vCPU, 2 GiB)",
              recommended: true,
            },
          ],
        },
        {
          key: "compute",
          label: "Compute Optimized (c5/c6i) — $0.085-0.34/hr",
          description: "High-performance CPUs.",
          options: [
            { value: "c5.large", label: "c5.large (2 vCPU, 4 GiB)" },
            { value: "c5.xlarge", label: "c5.xlarge (4 vCPU, 8 GiB)" },
          ],
        },
      ],
    },
  };

  it("two-step flow: category select then size select returns instance type value", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("burstable")
      .mockResolvedValueOnce("t3.small");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toBe("t3.small");
  });

  it("skips category step when categoryHint is set (intent-based skip)", async () => {
    vi.mocked(select).mockResolvedValueOnce("t3.small");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, {
      ...resolved,
      value: "t3.small",
      categoryHint: "burstable",
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(result).toBe("t3.small");
    expect(vi.mocked(log).info).toHaveBeenCalledWith(
      expect.stringContaining("Category auto-selected"),
    );
  });

  it("? at category level shows help note and re-prompts", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("?")
      .mockResolvedValueOnce("compute")
      .mockResolvedValueOnce("c5.large");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(vi.mocked(note)).toHaveBeenCalled();
    expect(result).toBe("c5.large");
  });

  it("non-TTY returns default value without prompting", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(select).not.toHaveBeenCalled();
    expect(result).toBe("t3.micro");
  });

  it("returns default when categories is empty", async () => {
    const emptyField: ResourceField = {
      name: "InstanceType",
      question: {
        type: "categorySelect",
        label: "Instance type",
        initialValue: "t3.micro",
        categories: [],
      },
    };

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(emptyField, resolved);

    expect(result).toBe("t3.micro");
  });

  it("all category labels include price range strings", () => {
    for (const cat of categoryField.question.categories!) {
      expect(cat.label).toMatch(/\$/);
    }
  });
});

// ── Epic 35 — Actionable Findings test matrix ─────────────────────────────────

import type { BPFinding } from "@assignee/best-practices";
import {
  resolveAction,
  countFixable,
  countAutoFixable,
} from "./fix-command-resolver.js";

/**
 * Realistic BP-style findings used across the Epic 35 test matrix.
 * All include propertyPath and use real S3/EC2 practice IDs.
 */
const s3PublicAccessFinding: BPFinding = {
  practiceId: "BP-S3-001",
  title: "Block S3 Public Access",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket allows public access",
  remediation: "Enable PublicAccessBlockConfiguration on the bucket",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true },
  },
};

const s3PublicPolicyFinding: BPFinding = {
  practiceId: "BP-S3-001b",
  title: "Block S3 Public Policy",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket allows public policy",
  remediation: "Set BlockPublicPolicy to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.BlockPublicPolicy",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { BlockPublicPolicy: true },
  },
};

const s3IgnorePublicAclsFinding: BPFinding = {
  practiceId: "BP-S3-001c",
  title: "Ignore Public ACLs",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket does not ignore public ACLs",
  remediation: "Set IgnorePublicAcls to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.IgnorePublicAcls",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { IgnorePublicAcls: true },
  },
};

const s3RestrictPublicBucketsFinding: BPFinding = {
  practiceId: "BP-S3-001d",
  title: "Restrict Public Buckets",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket does not restrict public buckets",
  remediation: "Set RestrictPublicBuckets to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.RestrictPublicBuckets",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { RestrictPublicBuckets: true },
  },
};

const s3EncryptionFinding: BPFinding = {
  practiceId: "BP-S3-006",
  title: "Enable S3 Default Encryption",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket lacks default encryption",
  remediation: "Configure ServerSideEncryptionConfiguration with AES256",
  blocking: true,
  autoFixable: true,
  propertyPath: "BucketEncryption.ServerSideEncryptionConfiguration",
  desiredStatePatch: {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: "AES256",
    },
  },
};

const ec2EbsEncryptionFinding: BPFinding = {
  practiceId: "BP-EC2-003",
  title: "Encrypt EBS Volumes",
  severity: "HIGH",
  category: "security",
  message: "EBS volumes should be encrypted at rest",
  remediation: "Set Ebs.Encrypted to true in BlockDeviceMappings",
  blocking: false,
  autoFixable: true,
  propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
  desiredStatePatch: {
    BlockDeviceMappings: [{ Ebs: { Encrypted: true } }],
  },
};

const s3LifecycleFinding: BPFinding = {
  practiceId: "BP-S3-010",
  title: "Configure S3 Lifecycle Rules",
  severity: "MEDIUM",
  category: "cost",
  message: "S3 bucket has no lifecycle rules for cost management",
  remediation:
    "Add LifecycleConfiguration rules to transition or expire objects",
  blocking: false,
  autoFixable: false,
  propertyPath: "LifecycleConfiguration",
};

const s3VersioningInfoFinding: BPFinding = {
  practiceId: "BP-S3-010",
  title: "Enable Versioning for Backup",
  severity: "INFO",
  category: "reliability",
  message: "Versioning improves data durability",
  remediation: "Set VersioningConfiguration.Status to Enabled",
  blocking: false,
  autoFixable: false,
  fixType: "info",
  propertyPath: "VersioningConfiguration.Status",
  fixHint: "Consider enabling versioning for data protection",
};

const manualFindingWithHint: BPFinding = {
  practiceId: "BP-S3-020",
  title: "Configure CORS Policy",
  severity: "INFO",
  category: "security",
  message: "Bucket may need CORS configuration for web access",
  remediation: "raw remediation text that should not appear",
  blocking: false,
  autoFixable: false,
  fixType: "info",
  propertyPath: "",
  fixHint: "Review CORS requirements for your web application",
};

describe("Epic 35 — Actionable Findings test matrix", () => {
  // ── A. formatFindings display ──────────────────────────────────────────────

  describe("A. formatFindings display", () => {
    describe("TTY mode", () => {
      beforeEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: true,
          configurable: true,
        });
      });
      afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      });

      it("1. findings show title on first line, hint on second line with → prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3PublicAccessFinding]);
        const lines = result.split("\n");
        // First line is summary, then finding title, then hint
        const titleLine = lines.find((l) =>
          l.includes("Block S3 Public Access"),
        );
        expect(titleLine).toBeDefined();
        const titleIdx = lines.indexOf(titleLine!);
        const hintLine = lines[titleIdx + 1];
        expect(hintLine).toContain("\u2192");
      });

      it("includes ⚠ Risk: line when finding has consequence (TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const findingWithConsequence: BPFinding = {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access via ACLs",
          remediation: "Enable PublicAccessBlockConfiguration on the bucket",
          blocking: true,
          autoFixable: true,
          propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          consequence:
            "Anyone on the internet can read bucket contents via ACLs.",
          desiredStatePatch: {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true },
          },
        };
        const result = formatFindings([findingWithConsequence]);
        expect(result).toContain("Risk:");
        expect(result.toLowerCase()).toContain(
          "anyone on the internet can read bucket contents via acls",
        );
      });

      it("omits Risk line when finding has no consequence (TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3PublicAccessFinding]);
        expect(result).not.toContain("Risk:");
      });
    });

    describe("non-TTY mode", () => {
      beforeEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: false,
          configurable: true,
        });
      });
      afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      });

      it("2. findings show title with [SEVERITY] marker, hint with -> prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3LifecycleFinding,
          s3VersioningInfoFinding,
        ]);
        expect(result).toContain("[MEDIUM] Configure S3 Lifecycle Rules");
        expect(result).toContain("[INFO] Enable Versioning for Backup");
        // Hints use -> prefix in non-TTY
        const lines = result.split("\n");
        const hintLines = lines.filter((l) => l.includes("->"));
        expect(hintLines.length).toBeGreaterThanOrEqual(2);
      });

      it("3. summary shows '(N fixable)' count when fixable findings exist", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ]);
        // 2 auto-fixable findings (PublicAccess + Encryption)
        expect(result).toMatch(/\(2 fixable\)/);
      });

      it("4. summary does NOT show '(fixable)' when 0 findings are fixable", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3LifecycleFinding,
          s3VersioningInfoFinding,
        ]);
        expect(result).not.toContain("fixable");
      });

      it("5. blocking findings NOT double-counted in medium/info severity", async () => {
        const { formatFindings } = await import("./display.js");
        // s3PublicAccessFinding is blocking + CRITICAL — should appear as blocking, not critical
        const result = formatFindings([
          s3PublicAccessFinding,
          s3LifecycleFinding,
        ]);
        expect(result).toContain("1 blocking");
        expect(result).toContain("1 medium");
        // Should NOT have "1 critical" since the CRITICAL finding is blocking
        expect(result).not.toContain("1 critical");
      });

      it("includes ! Risk: line when finding has consequence (non-TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const findingWithConsequence: BPFinding = {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access via ACLs",
          remediation: "Enable PublicAccessBlockConfiguration on the bucket",
          blocking: true,
          autoFixable: true,
          propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          consequence:
            "Anyone on the internet can read bucket contents via ACLs.",
          desiredStatePatch: {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true },
          },
        };
        const result = formatFindings([findingWithConsequence]);
        expect(result).toContain("! Risk:");
        expect(result).toContain(
          "Anyone on the internet can read bucket contents via ACLs.",
        );
      });

      it("omits Risk line when finding has no consequence (non-TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3LifecycleFinding]);
        expect(result).not.toContain("Risk:");
      });

      it("6. each hint line has exactly one of: Fix:, Manual:, Info: prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3PublicAccessFinding, // auto-fixable → Fix:
          s3LifecycleFinding, // manual → Manual:
          s3VersioningInfoFinding, // awareness → Info:
        ]);
        const lines = result.split("\n");
        const hintLines = lines.filter((l) => l.trim().startsWith("->"));
        expect(hintLines.length).toBe(3);
        for (const hl of hintLines) {
          const prefixMatches = [
            hl.includes("Fix:"),
            hl.includes("Manual:"),
            hl.includes("Info:"),
          ].filter(Boolean);
          expect(prefixMatches.length).toBe(1);
        }
      });
    });
  });

  // ── B. formatAutoFixHint ───────────────────────────────────────────────────

  describe("B. formatAutoFixHint (via renderPlanBox)", () => {
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

    it("7. returns null (no hint line) when autoFixEnabled=true", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: true,
        bpFindings: [s3PublicAccessFinding],
      });
      restore();

      const output = chunks.join("");
      expect(output).not.toContain("assignee init");
      expect(output).not.toContain("can be auto-fixed");
    });

    it("8. returns null (no hint line) when no auto-fixable findings", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3LifecycleFinding, s3VersioningInfoFinding],
      });
      restore();

      const output = chunks.join("");
      expect(output).not.toContain("assignee init");
      expect(output).not.toContain("can be auto-fixed");
    });

    it("9. shows correct count and 'assignee init' message when autoFix disabled + auto-fixable present", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ],
      });
      restore();

      const output = chunks.join("");
      expect(output).toContain("2 findings can be auto-fixed");
      expect(output).toContain("assignee init");
    });

    it("10. shows correct pluralization ('1 finding' vs '2 findings')", async () => {
      const { renderPlanBox } = await import("./display.js");

      // Single auto-fixable
      const { chunks: chunks1, restore: restore1 } = captureStream(
        process.stdout,
      );
      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3PublicAccessFinding],
      });
      restore1();
      const output1 = chunks1.join("");
      expect(output1).toContain("1 finding can be auto-fixed");
      expect(output1).not.toContain("1 findings");

      // Multiple auto-fixable
      const { chunks: chunks2, restore: restore2 } = captureStream(
        process.stdout,
      );
      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });
      restore2();
      const output2 = chunks2.join("");
      expect(output2).toContain("2 findings can be auto-fixed");
    });
  });

  // ── C. promptFixSelection ──────────────────────────────────────────────────

  describe("C. promptFixSelection", () => {
    it("11. returns null when non-TTY (process.stdin.isTTY = false)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("12. returns null when autoApprove=true", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        autoApprove: true,
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("13. returns null when no fixable findings", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [s3VersioningInfoFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("14. returns null when no findings have desiredStatePatch (fixable but no patch)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const noPatchFinding: BPFinding = {
        practiceId: "BP-S3-050",
        title: "Manual fix only",
        severity: "HIGH",
        category: "security",
        message: "Needs manual intervention",
        blocking: false,
        autoFixable: false,
        propertyPath: "SomeProperty",
      };
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [noPatchFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("15. returns null when user chooses 'skip'", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("skip");
      vi.mocked(isCancel).mockReturnValueOnce(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("16. 'Fix all' applies all patches and returns updated state with correct counts", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ],
      });

      expect(result).not.toBeNull();
      // Only 2 fixable findings were applied (lifecycle has no patch)
      expect(result!.appliedFixes.length).toBe(2);
      // Residual findings should only contain the non-fixable lifecycle finding
      expect(result!.bpFindings.length).toBe(1);
      expect(result!.bpFindings[0]!.practiceId).toBe("BP-S3-010");
      // Desired state should contain the merged patches
      expect(result!.desiredState).toHaveProperty("BucketName", "my-bucket");
      expect(result!.desiredState).toHaveProperty(
        "PublicAccessBlockConfiguration",
      );
      expect(
        (result!.desiredState as any).PublicAccessBlockConfiguration
          .BlockPublicAcls,
      ).toBe(true);
      expect(result!.desiredState).toHaveProperty("BucketEncryption");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-1: "Choose which" — fix some, skip some ──

    it("P0-1. 'Choose which' applies selected patches and skips others", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose", then Y for PublicAccess, N for Encryption, Y for PublicPolicy
      vi.mocked(select)
        .mockResolvedValueOnce("choose") // initial menu
        .mockResolvedValueOnce("fix") // finding 1: PublicAccess → fix
        .mockResolvedValueOnce("skip") // finding 2: Encryption → skip
        .mockResolvedValueOnce("fix"); // finding 3: PublicPolicy → fix
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3PublicPolicyFinding,
          s3LifecycleFinding, // non-fixable — should stay in residual
        ],
      });

      expect(result).not.toBeNull();
      // Only 2 fixes applied (PublicAccess + PublicPolicy), Encryption was skipped
      expect(result!.appliedFixes.length).toBe(2);
      expect(result!.appliedFixes.map((f) => f.practiceId)).toContain(
        "BP-S3-001",
      );
      expect(result!.appliedFixes.map((f) => f.practiceId)).toContain(
        "BP-S3-001b",
      );
      // Residual: skipped Encryption + non-fixable Lifecycle
      expect(result!.bpFindings.length).toBe(2);
      expect(result!.bpFindings.map((f) => f.practiceId)).toContain(
        "BP-S3-006",
      );
      expect(result!.bpFindings.map((f) => f.practiceId)).toContain(
        "BP-S3-010",
      );
      // DesiredState has patches from fixed findings only
      expect(
        (result!.desiredState as any).PublicAccessBlockConfiguration
          .BlockPublicAcls,
      ).toBe(true);
      expect(
        (result!.desiredState as any).PublicAccessBlockConfiguration
          .BlockPublicPolicy,
      ).toBe(true);
      // Encryption patch was skipped — should NOT be in desiredState
      expect(result!.desiredState).not.toHaveProperty("BucketEncryption");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-2: "Choose which" — skip all → returns null ──

    it("P0-2. 'Choose which' with all skipped returns null", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select)
        .mockResolvedValueOnce("choose") // initial menu
        .mockResolvedValueOnce("skip") // finding 1 → skip
        .mockResolvedValueOnce("skip"); // finding 2 → skip
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      expect(result).toBeNull();

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-3: Multiple PublicAccessBlock sub-property patches deep-merged ──

    it("P0-3. 'Fix all' merges multiple patches to same top-level key (PublicAccessBlock deep-merge)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3PublicPolicyFinding,
          s3IgnorePublicAclsFinding,
          s3RestrictPublicBucketsFinding,
        ],
      });

      expect(result).not.toBeNull();
      expect(result!.appliedFixes.length).toBe(4);
      // All 4 findings fixed → residual should be empty
      expect(result!.bpFindings.length).toBe(0);
      // All 4 sub-properties merged into single PublicAccessBlockConfiguration object
      const pab = (result!.desiredState as any).PublicAccessBlockConfiguration;
      expect(pab.BlockPublicAcls).toBe(true);
      expect(pab.BlockPublicPolicy).toBe(true);
      expect(pab.IgnorePublicAcls).toBe(true);
      expect(pab.RestrictPublicBuckets).toBe(true);

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P1-4: Cancel during "Choose which" with no fixes yet → returns null ──

    it("P1-4. cancel (stdin closed) during 'Choose which' before any fix returns null", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose", second select → throws (stdin closed / Ctrl+C)
      vi.mocked(select)
        .mockResolvedValueOnce("choose")
        .mockRejectedValueOnce(new Error("stdin closed"));
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      // No fixes were applied before error → null (catch block: fixedIds.size === 0)
      expect(result).toBeNull();

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P1-5: Cancel during "Choose which" after partial fix → partial result ──

    it("P1-5. cancel during 'Choose which' after partial fix preserves applied fixes", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose"
      // Second select → "fix" (applies first finding)
      // Third select → cancelled
      vi.mocked(select)
        .mockResolvedValueOnce("choose")
        .mockResolvedValueOnce("fix")
        .mockRejectedValueOnce(new Error("stdin closed")); // simulates Ctrl+C / stdin close
      vi.mocked(isCancel)
        .mockReturnValueOnce(false) // "choose"
        .mockReturnValueOnce(false); // "fix"

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      // One fix was applied before the error → partial result preserved
      expect(result).not.toBeNull();
      expect(result!.appliedFixes.length).toBe(1);
      expect(result!.appliedFixes[0]!.practiceId).toBe("BP-S3-001");
      // The fixed finding should be removed from residual
      expect(result!.bpFindings.some((f) => f.practiceId === "BP-S3-001")).toBe(
        false,
      );
      // The unfixed finding should remain
      expect(result!.bpFindings.some((f) => f.practiceId === "BP-S3-006")).toBe(
        true,
      );

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });
  });

  // ── D. FixCommandResolver with real BP data ────────────────────────────────

  describe("D. FixCommandResolver with real BP data", () => {
    it("17. S3 PublicAccessBlock patches: each sub-property gets its own correct --set flag", () => {
      const actionAcls = resolveAction(s3PublicAccessFinding);
      expect(actionAcls.category).toBe("auto-fixable");
      expect(actionAcls.hint).toContain("--set BlockPublicAcls=true");

      const actionPolicy = resolveAction(s3PublicPolicyFinding);
      expect(actionPolicy.category).toBe("auto-fixable");
      expect(actionPolicy.hint).toContain("--set BlockPublicPolicy=true");

      const actionIgnore = resolveAction(s3IgnorePublicAclsFinding);
      expect(actionIgnore.category).toBe("auto-fixable");
      expect(actionIgnore.hint).toContain("--set IgnorePublicAcls=true");

      const actionRestrict = resolveAction(s3RestrictPublicBucketsFinding);
      expect(actionRestrict.category).toBe("auto-fixable");
      expect(actionRestrict.hint).toContain("--set RestrictPublicBuckets=true");
    });

    it("18. S3 Encryption patch shows --set BucketEncryption=AES256", () => {
      const action = resolveAction(s3EncryptionFinding);
      expect(action.category).toBe("auto-fixable");
      expect(action.fixable).toBe(true);
      expect(action.hint).toContain("--set BucketEncryption=AES256");
    });

    it("19. EC2 EBS encryption patch drills into array to show --set EbsEncrypted=true", () => {
      const action = resolveAction(ec2EbsEncryptionFinding);
      expect(action.category).toBe("auto-fixable");
      expect(action.fixable).toBe(true);
      expect(action.hint).toContain("--set EbsEncrypted=true");
    });

    it("20. Manual finding with fix_hint shows the hint, not raw remediation", () => {
      const action = resolveAction(manualFindingWithHint);
      expect(action.fixable).toBe(false);
      expect(action.hint).toBe(
        "Review CORS requirements for your web application",
      );
      // Must NOT show raw remediation
      expect(action.hint).not.toContain("raw remediation text");
    });
  });

  // ── E. deepMergePatch prototype pollution guard (P2-1) ──────────────────────

  describe("E. deepMergePatch prototype pollution guard", () => {
    it("P2-1. rejects __proto__, constructor, prototype keys in nested patches via promptFixSelection", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      // Test dangerous keys as NESTED keys inside a safe root key.
      // deepMergePatch recurses into nested objects, so the guard must reject
      // __proto__, constructor, prototype at every depth level.
      // We use a safe root key ("Config") so resolveAction processes it
      // without hitting the wizardKeyMap prototype chain issue.
      const pollutionFinding: BPFinding = {
        practiceId: "BP-POLLUTION-001",
        title: "Prototype pollution test",
        severity: "HIGH",
        category: "security",
        message: "Test finding with nested dangerous keys",
        blocking: false,
        autoFixable: true,
        propertyPath: "Config.SafeNested",
        desiredStatePatch: {
          Config: {
            ["__proto__"]: { polluted: true },
            constructor: { polluted: true },
            prototype: { polluted: true },
            SafeNested: "nested-safe-value",
          },
        },
      };

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket", Config: { Existing: "yes" } },
        bpFindings: [pollutionFinding],
      });

      expect(result).not.toBeNull();
      // Global Object.prototype must NOT be polluted
      expect(({} as any).polluted).toBeUndefined();

      // Nested Config object: safe key applied, dangerous keys skipped
      const config = (result!.desiredState as any).Config;
      expect(config).toBeDefined();
      expect(config.SafeNested).toBe("nested-safe-value");
      expect(config.Existing).toBe("yes"); // original key preserved by deep merge
      expect(Object.keys(config)).not.toContain("__proto__");
      expect(Object.keys(config)).not.toContain("constructor");
      expect(Object.keys(config)).not.toContain("prototype");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });
  });
});

describe("resolveSetKey", () => {
  it("resolves human alias 'size' to InstanceType", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("size")).toBe("InstanceType");
  });

  it("resolves human alias 'memory' to MemorySize", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("memory")).toBe("MemorySize");
  });

  it("resolves friendly name 'Instance Type' case-insensitively", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("instance type")).toBe("InstanceType");
  });

  it("passes through PascalCase CfnKeys unchanged", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("BucketName")).toBe("BucketName");
  });

  it("returns unknown keys unchanged", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("unknownField")).toBe("unknownField");
  });
});
