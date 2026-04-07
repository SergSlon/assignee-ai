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
    expect(manifest.startedAt).toBeDefined();
    expect(manifest.completedAt).toBeDefined();
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

// ── Recording disabled: no file I/O ─────────────────────────────────────────

describe("recording disabled behavior", () => {
  it("isRecordingEnabled returns false by default (no env var)", () => {
    const orig = process.env["ASSIGNEE_RECORD"];
    delete process.env["ASSIGNEE_RECORD"];
    expect(isRecordingEnabled()).toBe(false);
    if (orig !== undefined) process.env["ASSIGNEE_RECORD"] = orig;
  });
});
