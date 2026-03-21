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
    expect(output).toContain("run-display-test-123");
    // No ANSI escape codes
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("renderPlanBox includes Resource Type, Region, Config, Estimated Cost, Run ID fields", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).toContain("Resource Type");
    expect(output).toContain("Region");
    expect(output).toContain("Config");
    expect(output).toContain("Estimated Cost");
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

  it("returns false when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderHitlCompoundConfirm } = await import("./display.js");
    const result = await renderHitlCompoundConfirm(mockPattern, 3);
    expect(result).toBe(false);
  });
});

// ── renderOptionPrompt tests ──────────────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  isCancel: vi.fn(() => false),
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

  it("calls clack.select for boolean type", async () => {
    vi.mocked(select).mockResolvedValueOnce("true");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(select).toHaveBeenCalledWith(
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

  it("returns resolved.value when clack.isCancel returns true", async () => {
    vi.mocked(text).mockResolvedValueOnce(
      Symbol("cancel") as unknown as string,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(makeField({ type: "string" }), {
      ...resolved,
      value: "fallback",
    });
    expect(result).toBe("fallback");
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
  return {
    name,
    description: "",
    invoke: vi.fn().mockImplementation(invokeFn),
  } as unknown as StructuredTool;
}

describe("renderDocHelp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows fallback when search tool not in tools array", async () => {
    const { renderDocHelp } = await import("./display.js");

    await renderDocHelp("BucketName", "AWS::S3::Bucket", []);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
    );
  });

  it("shows fallback when search tool times out (returns null via race)", async () => {
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
    await promise;
    vi.useRealTimers();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
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

  it("calls clack.note with description when search + read succeed", async () => {
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
    await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
      expect.stringContaining("📖 BucketName"),
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

    it("calls generateText and displays synthesized hint when LLM succeeds", async () => {
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
      await renderDocHelp(
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
