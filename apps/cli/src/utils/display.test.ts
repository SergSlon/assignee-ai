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

// ── Guardrail findings rendering (Story 10.4) ────────────────────────────────

describe("renderPlanBox with guardrail findings — non-TTY", () => {
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

    renderPlanBox({ ...mockState, guardrailFindings: [] });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
    expect(output).toContain("Guardrails:");
  });

  it("shows 'All checks passed' when findings is undefined", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, guardrailFindings: undefined });
    restore();

    const output = chunks.join("");
    expect(output).toContain("All checks passed");
  });

  it("shows critical and warning findings with plain text markers", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      guardrailFindings: [
        {
          ruleId: "s3-public-access",
          severity: "critical",
          message: "S3 bucket has public access enabled",
        },
        {
          ruleId: "s3-missing-lifecycle",
          severity: "warning",
          message: "S3 bucket is missing lifecycle rules",
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("1 critical, 1 warnings");
    expect(output).toContain("[CRITICAL] S3 bucket has public access enabled");
    expect(output).toContain("[WARNING] S3 bucket is missing lifecycle rules");
    // No ANSI escape codes in non-TTY mode
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("shows correct counts for multiple criticals", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      guardrailFindings: [
        {
          ruleId: "s3-public-access",
          severity: "critical",
          message: "Public access issue",
        },
        {
          ruleId: "missing-encryption",
          severity: "critical",
          message: "Encryption issue",
        },
        {
          ruleId: "s3-missing-lifecycle",
          severity: "warning",
          message: "Lifecycle issue",
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("2 critical, 1 warnings");
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

  it("shows 'No best practice findings' when bpFindings is empty", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: [] });
    restore();

    const output = chunks.join("");
    expect(output).toContain("No best practice findings");
    expect(output).toContain("Best Practices:");
  });

  it("shows 'No best practice findings' when bpFindings is undefined", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, bpFindings: undefined });
    restore();

    const output = chunks.join("");
    expect(output).toContain("No best practice findings");
  });

  it("shows violations and warnings with plain text markers", async () => {
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
        },
        {
          practiceId: "BP-S3-002",
          title: "Enable S3 Default Encryption",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket should have default encryption",
          remediation: "Configure ServerSideEncryptionConfiguration",
        },
      ],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("1 violation");
    expect(output).toContain("1 warning");
    expect(output).toContain("[CRITICAL] Enable S3 Default Encryption");
    expect(output).toContain("[MEDIUM] Enable S3 Bucket Versioning");
    // Remediation hints shown
    expect(output).toContain("Configure ServerSideEncryptionConfiguration");
    // No ANSI escape codes in non-TTY mode
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("maps severity icons correctly", async () => {
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
        },
        {
          practiceId: "BP-S3-011",
          title: "INFO Finding",
          severity: "INFO",
          category: "cost",
          message: "Informational finding",
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
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders CRITICAL finding with red indicator", async () => {
    const { renderSecurityWarnings } = await import("./display.js");
    const logSpy = vi.mocked(console.log);

    renderSecurityWarnings("arn:aws:s3:::my-bucket", [
      {
        severity: "CRITICAL",
        title: "S3 bucket has public read access",
        recommendation: "Block public access",
        service: "SecurityHub",
      },
    ]);

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("Security findings for arn:aws:s3:::my-bucket");
    expect(allOutput).toContain("[CRITICAL] S3 bucket has public read access");
    expect(allOutput).toContain("Block public access");
  });

  it("renders multiple findings with recommendations", async () => {
    const { renderSecurityWarnings } = await import("./display.js");
    const logSpy = vi.mocked(console.log);

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

    const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("[CRITICAL] Public access enabled");
    expect(allOutput).toContain("[HIGH] No encryption");
    expect(allOutput).toContain("Disable public access");
    expect(allOutput).toContain("Enable SSE-S3");
  });

  it("does nothing when findings array is empty", async () => {
    const { renderSecurityWarnings } = await import("./display.js");
    const logSpy = vi.mocked(console.log);

    renderSecurityWarnings("arn:aws:s3:::my-bucket", []);

    expect(logSpy).not.toHaveBeenCalled();
  });
});
