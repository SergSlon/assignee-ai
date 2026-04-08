/**
 * Unit tests for the recording interceptor infrastructure.
 * Uses real temp directories instead of mocking node:fs (ESM-incompatible).
 * @see Story 9.7
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isRecordingEnabled,
  getRecordingDir,
  RecordingInterceptor,
  wrapToolWithRecorder,
  RecordingLlmAdapter,
  sanitizeFilenameSegment,
  redactStringValue,
  addRecordingMiddleware,
} from "./recorder.js";

// ── isRecordingEnabled ──────────────────────────────────────────────────────

describe("isRecordingEnabled", () => {
  const original = process.env["ASSIGNEE_RECORD"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["ASSIGNEE_RECORD"];
    } else {
      process.env["ASSIGNEE_RECORD"] = original;
    }
  });

  it("returns false when ASSIGNEE_RECORD is not set", () => {
    delete process.env["ASSIGNEE_RECORD"];
    expect(isRecordingEnabled()).toBe(false);
  });

  it("returns false when ASSIGNEE_RECORD is empty", () => {
    process.env["ASSIGNEE_RECORD"] = "";
    expect(isRecordingEnabled()).toBe(false);
  });

  it("returns false when ASSIGNEE_RECORD is 0", () => {
    process.env["ASSIGNEE_RECORD"] = "0";
    expect(isRecordingEnabled()).toBe(false);
  });

  it("returns true when ASSIGNEE_RECORD is 1", () => {
    process.env["ASSIGNEE_RECORD"] = "1";
    expect(isRecordingEnabled()).toBe(true);
  });
});

// ── getRecordingDir ─────────────────────────────────────────────────────────

describe("getRecordingDir", () => {
  it("returns a path containing the runId", () => {
    const dir = getRecordingDir("test-run-123");
    expect(dir).toContain("test-run-123");
    expect(dir).toContain("recordings");
  });
});

// ── Helper: create a RecordingInterceptor that writes to a temp dir ─────────

function createTestRecorder(
  runId: string,
  command = "",
): { recorder: RecordingInterceptor; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join("/tmp", "recorder-test-"));
  // We override the internal dir by subclassing
  const recorder = new RecordingInterceptor(runId, command);
  // Access private dir via prototype trick — set it to our tmpDir

  (recorder as any).dir = tmpDir;
  return { recorder, tmpDir };
}

function cleanup(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function readRecordedFile(
  tmpDir: string,
  index: number,
): Record<string, unknown> {
  const files = fs
    .readdirSync(tmpDir)
    .filter((f) => f.endsWith(".json") && f !== "_manifest.json")
    .sort();
  const content = fs.readFileSync(path.join(tmpDir, files[index]!), "utf-8");
  return JSON.parse(content);
}

// ── RecordingInterceptor ─────────────────────────────────────────────────────

describe("RecordingInterceptor", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it("records an MCP call to a JSON file", () => {
    const t = createTestRecorder("run-1", "plan test");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "get_pricing",
      input: { service_code: "AmazonS3" },
      output: { type: "text", text: "{}" },
      durationMs: 100,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("mcp-get_pricing-");

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("mcp");
    expect(parsed["tool"]).toBe("get_pricing");
    expect(parsed["durationMs"]).toBe(100);
    expect(parsed["input"]).toEqual({ service_code: "AmazonS3" });
  });

  it("records an SDK call to a JSON file", () => {
    const t = createTestRecorder("run-2");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "sdk",
      service: "CloudControl",
      operation: "CreateResource",
      input: { TypeName: "AWS::S3::Bucket" },
      output: { ProgressEvent: {} },
      durationMs: 250,
      timestamp: "2026-03-22T10:00:01.000Z",
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("sdk-CloudControl-CreateResource-");

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("sdk");
    expect(parsed["service"]).toBe("CloudControl");
  });

  it("records an LLM call to a JSON file", () => {
    const t = createTestRecorder("run-3");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "llm",
      method: "generateText",
      prompt: "Hello",
      response: "Hi there",
      model: "anthropic/claude-sonnet-4-5",
      durationMs: 500,
      timestamp: "2026-03-22T10:00:02.000Z",
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("llm-generateText-");

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("llm");
    expect(parsed["method"]).toBe("generateText");
    expect(parsed["model"]).toBe("anthropic/claude-sonnet-4-5");
  });

  it("records errors for failed calls (no output field)", () => {
    const t = createTestRecorder("run-4");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "get_pricing",
      input: { service_code: "BadService" },
      error: "Service not found",
      durationMs: 50,
      timestamp: "2026-03-22T10:00:03.000Z",
    });

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["error"]).toBe("Service not found");
    expect(parsed["output"]).toBeUndefined();
  });

  it("tracks recorded file names via getRecordedFiles()", () => {
    const t = createTestRecorder("run-5");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "get_pricing",
      input: {},
      output: {},
      durationMs: 10,
      timestamp: "2026-03-22T10:00:00.000Z",
    });
    t.recorder.recordCall({
      type: "llm",
      method: "generateText",
      prompt: "hi",
      response: "hello",
      model: "test",
      durationMs: 20,
      timestamp: "2026-03-22T10:00:01.000Z",
    });

    const files = t.recorder.getRecordedFiles();
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("mcp-get_pricing-");
    expect(files[1]).toContain("llm-generateText-");
  });

  it("generates a manifest on finalizeSession()", () => {
    const t = createTestRecorder("run-6", "plan test");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "test_tool",
      input: {},
      output: {},
      durationMs: 10,
      timestamp: "2026-03-22T10:00:00.000Z",
    });
    t.recorder.finalizeSession();

    const manifestPath = path.join(tmpDir, "_manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest.runId).toBe("run-6");
    expect(manifest.command).toBe("plan test");
    expect(manifest.files).toHaveLength(1);
    // Tier C: strengthened — assert ISO timestamp shape, not just defined
    expect(manifest.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(manifest.completedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(manifest.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("swallows write errors silently (never crashes CLI)", () => {
    const recorder = new RecordingInterceptor("run-err");
    // Point to an impossible path

    (recorder as any).dir = "/nonexistent/impossible/path/XXXX";

    (recorder as any).dirCreated = true; // skip mkdirSync, force writeFileSync to fail

    expect(() =>
      recorder.recordCall({
        type: "mcp",
        tool: "test",
        input: {},
        output: {},
        durationMs: 10,
        timestamp: "2026-03-22T10:00:00.000Z",
      }),
    ).not.toThrow();
  });
});

// ── wrapToolWithRecorder ─────────────────────────────────────────────────────

describe("wrapToolWithRecorder", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it("records successful tool invocations", async () => {
    const mockTool = {
      name: "get_pricing",
      invoke: vi.fn().mockResolvedValue({ type: "text", text: '{"price":1}' }),
    } as unknown as import("@langchain/core/tools").StructuredTool;

    const t = createTestRecorder("run-tool-1");
    tmpDir = t.tmpDir;
    const wrapped = wrapToolWithRecorder(mockTool, t.recorder);

    const result = await wrapped.invoke({ service_code: "AmazonS3" });

    expect(result).toEqual({ type: "text", text: '{"price":1}' });
    expect(t.recorder.getRecordedFiles()).toHaveLength(1);
    expect(t.recorder.getRecordedFiles()[0]).toContain("mcp-get_pricing-");

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("mcp");
    expect(parsed["tool"]).toBe("get_pricing");
    expect(parsed["output"]).toEqual({ type: "text", text: '{"price":1}' });
  });

  it("records failed tool invocations and rethrows", async () => {
    const mockTool = {
      name: "get_pricing",
      invoke: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as import("@langchain/core/tools").StructuredTool;

    const t = createTestRecorder("run-tool-2");
    tmpDir = t.tmpDir;
    const wrapped = wrapToolWithRecorder(mockTool, t.recorder);

    await expect(wrapped.invoke({ service_code: "AmazonS3" })).rejects.toThrow(
      "timeout",
    );

    expect(t.recorder.getRecordedFiles()).toHaveLength(1);
    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["error"]).toContain("timeout");
  });

  it("preserves tool name on wrapped tool", () => {
    const mockTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as import("@langchain/core/tools").StructuredTool;

    const t = createTestRecorder("run-tool-3");
    tmpDir = t.tmpDir;
    const wrapped = wrapToolWithRecorder(mockTool, t.recorder);

    expect(wrapped.name).toBe("get_pricing");
  });
});

// ── RecordingLlmAdapter ─────────────────────────────────────────────────────

describe("RecordingLlmAdapter", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it("records generateText calls with correct shape", async () => {
    const mockLlm = {
      generateText: vi.fn().mockResolvedValue([null, "Hello world"]),
      generateStructured: vi.fn(),
    };

    const t = createTestRecorder("run-llm-1");
    tmpDir = t.tmpDir;
    const adapter = new RecordingLlmAdapter(mockLlm, t.recorder, "test-model");

    const result = await adapter.generateText("Say hello");

    expect(result).toEqual([null, "Hello world"]);
    expect(t.recorder.getRecordedFiles()).toHaveLength(1);

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("llm");
    expect(parsed["method"]).toBe("generateText");
    expect(parsed["prompt"]).toBe("Say hello");
    expect(parsed["response"]).toBe("Hello world");
    expect(parsed["model"]).toBe("test-model");
    expect(parsed["durationMs"]).toBeGreaterThanOrEqual(0);
  });

  it("records generateStructured calls with correct shape", async () => {
    const mockLlm = {
      generateText: vi.fn(),
      generateStructured: vi
        .fn()
        .mockResolvedValue([null, { resourceType: "AWS::S3::Bucket" }]),
    };

    const t = createTestRecorder("run-llm-2");
    tmpDir = t.tmpDir;
    const adapter = new RecordingLlmAdapter(mockLlm, t.recorder, "test-model");

    const mockSchema = {} as import("zod").ZodSchema;
    const result = await adapter.generateStructured("Parse intent", mockSchema);

    expect(result).toEqual([null, { resourceType: "AWS::S3::Bucket" }]);

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["type"]).toBe("llm");
    expect(parsed["method"]).toBe("generateStructured");
    expect(parsed["response"]).toEqual({ resourceType: "AWS::S3::Bucket" });
  });

  it("records LLM errors with error field instead of response", async () => {
    const mockLlm = {
      generateText: vi.fn().mockResolvedValue([new Error("LLM timeout"), null]),
      generateStructured: vi.fn(),
    };

    const t = createTestRecorder("run-llm-3");
    tmpDir = t.tmpDir;
    const adapter = new RecordingLlmAdapter(mockLlm, t.recorder, "test-model");

    const result = await adapter.generateText("Say hello");

    expect(result[0]).toBeInstanceOf(Error);

    const parsed = readRecordedFile(tmpDir, 0);
    expect(parsed["error"]).toContain("LLM timeout");
    expect(parsed["response"]).toBeUndefined();
  });
});

// ── Filename sanitization (M-S1: path traversal hardening) ─────────────────

describe("sanitizeFilenameSegment", () => {
  it("replaces path traversal sequences with underscores", () => {
    expect(sanitizeFilenameSegment("../etc/passwd")).toBe("___etc_passwd");
  });

  it("replaces forward slashes with underscores", () => {
    expect(sanitizeFilenameSegment("aws/s3/bucket")).toBe("aws_s3_bucket");
  });

  it("replaces backslashes with underscores", () => {
    expect(sanitizeFilenameSegment("aws\\s3\\bucket")).toBe("aws_s3_bucket");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeFilenameSegment("file.name.json")).toBe("file_name_json");
  });

  it("strips other unsafe characters", () => {
    expect(sanitizeFilenameSegment("aws$s3;bucket|prod")).toBe(
      "aws_s3_bucket_prod",
    );
  });

  it("preserves alphanumerics, underscores, and hyphens", () => {
    expect(sanitizeFilenameSegment("Get-Pricing_v1")).toBe("Get-Pricing_v1");
  });

  it("caps length at 64 characters", () => {
    const long = "a".repeat(200);
    const result = sanitizeFilenameSegment(long);
    expect(result.length).toBe(64);
    expect(result).toBe("a".repeat(64));
  });

  it("returns 'unknown' for an empty input", () => {
    expect(sanitizeFilenameSegment("")).toBe("unknown");
  });

  it("flattens '...' to underscores (not stripped — replaced)", () => {
    expect(sanitizeFilenameSegment("...")).toBe("___");
  });
});

describe("RecordingInterceptor — path traversal protection (M-S1)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it("sanitizes a malicious tool name containing ../etc/passwd", () => {
    const t = createTestRecorder("run-traversal");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "../etc/passwd",
      input: { service_code: "AmazonS3" },
      output: { type: "text", text: "{}" },
      durationMs: 10,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    // The dangerous "../etc/passwd" must be flattened to "___etc_passwd"
    expect(files[0]).toContain("___etc_passwd");
    expect(files[0]).not.toContain("..");
    expect(files[0]).not.toContain("/");
  });

  it("sanitizes malicious sdk service/operation names", () => {
    const t = createTestRecorder("run-traversal-sdk");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "sdk",
      service: "../../usr/bin",
      operation: "..\\..\\Windows",
      input: {},
      output: {},
      durationMs: 1,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
    expect(files[0]).not.toContain("/");
    expect(files[0]).not.toContain("\\");
  });
});

// ── String-value redaction (M-S2: AKIA / ARN scrubbing) ────────────────────

describe("redactStringValue", () => {
  it("redacts AKIA-prefixed access keys embedded in a string", () => {
    const result = redactStringValue("Found key AKIAIOSFODNN7EXAMPLE in env");
    expect(result).toBe("Found key [REDACTED-AKIA] in env");
  });

  it("redacts ASIA-prefixed STS session keys embedded in a string", () => {
    const result = redactStringValue("Session key ASIAIOSFODNN7EXAMPLE active");
    expect(result).toBe("Session key [REDACTED-AKIA] active");
  });

  it("redacts multiple access keys in a single string", () => {
    // Each AKIA key is exactly 20 chars (AKIA + 16 alphanumerics).
    const result = redactStringValue(
      "AKIAIOSFODNN7EXAMPLE and AKIAJOHNDOECODE0EXMP",
    );
    expect(result).toBe("[REDACTED-AKIA] and [REDACTED-AKIA]");
  });

  it("redacts the account ID from an IAM ARN", () => {
    const result = redactStringValue("arn:aws:iam::123456789012:user/operator");
    expect(result).toBe("arn:aws:iam::[REDACTED]:user/operator");
  });

  it("leaves unrelated strings untouched", () => {
    expect(redactStringValue("plain text without secrets")).toBe(
      "plain text without secrets",
    );
  });
});

describe("RecordingInterceptor — value-level redaction (M-S2)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanup(tmpDir);
  });

  it("redacts AKIA keys nested deep inside the input payload", () => {
    const t = createTestRecorder("run-akia-nested");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "mcp",
      tool: "get_pricing",
      input: {
        nested: {
          deep: {
            errorMessage: "user AKIAIOSFODNN7EXAMPLE was rejected",
          },
        },
      },
      output: {},
      durationMs: 1,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const parsed = readRecordedFile(tmpDir, 0) as Record<string, unknown>;
    const inputObj = parsed["input"] as Record<string, unknown>;
    const nested = inputObj["nested"] as Record<string, unknown>;
    const deep = nested["deep"] as Record<string, unknown>;
    expect(deep["errorMessage"]).toBe("user [REDACTED-AKIA] was rejected");
  });

  it("redacts IAM ARN account IDs nested in the output payload", () => {
    const t = createTestRecorder("run-arn-nested");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "sdk",
      service: "iam",
      operation: "GetUser",
      input: {},
      output: {
        User: {
          Arn: "arn:aws:iam::123456789012:user/assignee-operator",
        },
      },
      durationMs: 1,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const parsed = readRecordedFile(tmpDir, 0) as Record<string, unknown>;
    const outputObj = parsed["output"] as Record<string, unknown>;
    const userObj = outputObj["User"] as Record<string, unknown>;
    expect(userObj["Arn"]).toBe(
      "arn:aws:iam::[REDACTED]:user/assignee-operator",
    );
  });

  it("redacts AKIA keys appearing inside an LLM prompt string", () => {
    const t = createTestRecorder("run-llm-akia");
    tmpDir = t.tmpDir;

    t.recorder.recordCall({
      type: "llm",
      method: "generateText",
      prompt:
        "User said: please use AKIAIOSFODNN7EXAMPLE for the bucket policy",
      response: "ok",
      model: "claude",
      durationMs: 1,
      timestamp: "2026-03-22T10:00:00.000Z",
    });

    const parsed = readRecordedFile(tmpDir, 0) as Record<string, unknown>;
    expect(parsed["prompt"]).toBe(
      "User said: please use [REDACTED-AKIA] for the bucket policy",
    );
  });
});

// ── REG-N8: addRecordingMiddleware type-safety regression ──────────────────
// The middlewareStack.add signature was previously typed `(...args: any[])`
// which silently accepted anything. Tighten to a real signature so future
// callers get a compile error if they pass the wrong shape, AND verify the
// middleware actually records SDK call success/failure at runtime.
describe("addRecordingMiddleware (REG-N8)", () => {
  function makeFakeClient() {
    const added: Array<{
      middleware: unknown;
      options: Record<string, unknown> | undefined;
    }> = [];
    return {
      added,
      middlewareStack: {
        add(middleware: unknown, options?: Record<string, unknown>): void {
          added.push({ middleware, options });
        },
      },
    };
  }

  it("registers a middleware function with deserialize step + name + priority", () => {
    const t = createTestRecorder("run-mw-register");
    try {
      const client = makeFakeClient();
      addRecordingMiddleware(client, t.recorder, "S3");

      expect(client.added).toHaveLength(1);
      expect(typeof client.added[0]!.middleware).toBe("function");
      expect(client.added[0]!.options).toEqual({
        step: "deserialize",
        name: "recordingMiddleware",
        priority: "low",
      });
    } finally {
      cleanup(t.tmpDir);
    }
  });

  it("middleware records successful SDK calls with input/output/duration", async () => {
    const t = createTestRecorder("run-mw-success");
    try {
      const client = makeFakeClient();
      addRecordingMiddleware(client, t.recorder, "CloudControl");

      // Pull the registered middleware out, hand it a fake `next` and context.
      const middleware = client.added[0]!.middleware as (
        next: (a: { input?: unknown }) => Promise<{ output?: unknown }>,
        ctx: { commandName?: string },
      ) => (a: { input?: unknown }) => Promise<{ output?: unknown }>;

      const handler = middleware(
        async () =>
          ({
            output: { ProgressEvent: { OperationStatus: "SUCCESS" } },
          }) as Record<string, unknown>,
        { commandName: "CreateResourceCommand" },
      );

      await handler({
        input: {
          TypeName: "AWS::S3::Bucket",
          DesiredState: '{"BucketName":"my-real-bucket-name"}',
        },
      });

      // RecordingInterceptor writes one .json file per call (not jsonl).
      const files = fs
        .readdirSync(t.tmpDir)
        .filter((f) => f.startsWith("sdk-") && f.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);
      const content = fs.readFileSync(path.join(t.tmpDir, files[0]!), "utf-8");
      const last = JSON.parse(content);
      expect(last.type).toBe("sdk");
      expect(last.service).toBe("CloudControl");
      expect(last.operation).toBe("CreateResourceCommand");
      expect(last.input.TypeName).toBe("AWS::S3::Bucket");
      expect(last.output.ProgressEvent.OperationStatus).toBe("SUCCESS");
      expect(typeof last.durationMs).toBe("number");
    } finally {
      cleanup(t.tmpDir);
    }
  });

  it("middleware records failed SDK calls and re-throws the error", async () => {
    const t = createTestRecorder("run-mw-fail");
    try {
      const client = makeFakeClient();
      addRecordingMiddleware(client, t.recorder, "EC2");

      const middleware = client.added[0]!.middleware as (
        next: (a: { input?: unknown }) => Promise<{ output?: unknown }>,
        ctx: { commandName?: string },
      ) => (a: { input?: unknown }) => Promise<{ output?: unknown }>;

      const handler = middleware(
        async () => {
          throw new Error("AccessDenied: not authorized to RunInstances");
        },
        { commandName: "RunInstancesCommand" },
      );

      await expect(
        handler({ input: { InstanceType: "t3.micro" } }),
      ).rejects.toThrow("AccessDenied");

      const files = fs
        .readdirSync(t.tmpDir)
        .filter((f) => f.startsWith("sdk-") && f.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);
      const content = fs.readFileSync(path.join(t.tmpDir, files[0]!), "utf-8");
      const last = JSON.parse(content);
      expect(last.type).toBe("sdk");
      expect(last.service).toBe("EC2");
      expect(last.operation).toBe("RunInstancesCommand");
      expect(last.error).toContain("AccessDenied");
      expect(last.output).toBeUndefined();
    } finally {
      cleanup(t.tmpDir);
    }
  });
});

// ── Recording disabled: no file I/O ─────────────────────────────────────────

describe("recording disabled behavior", () => {
  it("isRecordingEnabled returns false by default (no env var)", () => {
    const orig = process.env["ASSIGNEE_RECORD"];
    delete process.env["ASSIGNEE_RECORD"];
    expect(isRecordingEnabled()).toBe(false);
    if (orig !== undefined) process.env["ASSIGNEE_RECORD"] = orig;
  });
});
