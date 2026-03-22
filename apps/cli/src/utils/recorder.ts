/**
 * Recording interceptor for capturing external API calls to JSON fixtures.
 * Activated via `ASSIGNEE_RECORD=1` environment variable.
 * When disabled (default), zero overhead — no wrapping, no file I/O.
 *
 * Supports three call types:
 *   - MCP tool invocations (schema, pricing, docs, IAM, security, billing)
 *   - AWS SDK calls (CloudControl, EC2, SSM)
 *   - LLM calls (generateText, generateStructured)
 *
 * @see Story 9.7 — Request/Response Recording Interceptor for Test Fixtures
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { StructuredTool } from "@langchain/core/tools";
import type { LlmPort, Result, LlmError } from "@assignee/core";
import type { ZodSchema } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpRecordedCall {
  type: "mcp";
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface SdkRecordedCall {
  type: "sdk";
  service: string;
  operation: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface LlmRecordedCall {
  type: "llm";
  method: string;
  prompt: string;
  response?: unknown;
  error?: string;
  model: string;
  durationMs: number;
  timestamp: string;
}

export type RecordedCall = McpRecordedCall | SdkRecordedCall | LlmRecordedCall;

export interface RecordingManifest {
  runId: string;
  command: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  files: string[];
}

// ── Env check ────────────────────────────────────────────────────────────────

/**
 * Returns true when ASSIGNEE_RECORD=1 is set in the environment.
 * All recording logic is gated behind this check.
 */
export function isRecordingEnabled(): boolean {
  return process.env["ASSIGNEE_RECORD"] === "1";
}

// ── Recording directory ──────────────────────────────────────────────────────

const RECORDINGS_BASE = path.resolve(
  import.meta.dirname ?? __dirname,
  "..",
  "test-fixtures",
  "recordings",
);

/**
 * Returns the recording directory path for a given runId.
 */
export function getRecordingDir(runId: string): string {
  return path.join(RECORDINGS_BASE, runId);
}

// ── RecordingInterceptor ─────────────────────────────────────────────────────

/**
 * Manages a recording session: creates the output directory lazily,
 * writes individual call files, and generates a manifest on finalize.
 */
export class RecordingInterceptor {
  private readonly dir: string;
  private dirCreated = false;
  private readonly files: string[] = [];
  private readonly startedAt: string;

  constructor(
    private readonly runId: string,
    private readonly command: string = "",
  ) {
    this.dir = getRecordingDir(runId);
    this.startedAt = new Date().toISOString();
  }

  /**
   * Lazily ensures the recording directory exists.
   */
  private ensureDir(): void {
    if (this.dirCreated) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this.dirCreated = true;
  }

  /**
   * Generates a safe filename from call metadata.
   */
  private makeFilename(call: RecordedCall): string {
    const ts = call.timestamp.replace(/[:.]/g, "-");
    switch (call.type) {
      case "mcp":
        return `mcp-${call.tool}-${ts}.json`;
      case "sdk":
        return `sdk-${call.service}-${call.operation}-${ts}.json`;
      case "llm":
        return `llm-${call.method}-${ts}.json`;
    }
  }

  /**
   * Records a single call to a JSON file. Fire-and-forget — errors are swallowed
   * to never impact CLI behavior.
   */
  recordCall(call: RecordedCall): void {
    try {
      this.ensureDir();
      const filename = this.makeFilename(call);
      const filePath = path.join(this.dir, filename);
      fs.writeFileSync(filePath, JSON.stringify(call, null, 2) + "\n");
      this.files.push(filename);
    } catch {
      // Recording is best-effort — never fail the CLI
    }
  }

  /**
   * Writes `_manifest.json` summarizing all recorded files.
   */
  finalizeSession(): void {
    try {
      this.ensureDir();
      const manifest: RecordingManifest = {
        runId: this.runId,
        command: this.command,
        startedAt: this.startedAt,
        completedAt: new Date().toISOString(),
        totalDurationMs: Date.now() - new Date(this.startedAt).getTime(),
        files: [...this.files],
      };
      const filePath = path.join(this.dir, "_manifest.json");
      fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
    } catch {
      // Best-effort
    }
  }

  /** Returns the list of recorded filenames (for testing). */
  getRecordedFiles(): string[] {
    return [...this.files];
  }
}

// ── MCP tool wrapper ─────────────────────────────────────────────────────────

/**
 * Wraps a StructuredTool to record all invoke() calls.
 * The wrapped tool behaves identically to the original.
 */
export function wrapToolWithRecorder(
  tool: StructuredTool,
  recorder: RecordingInterceptor,
): StructuredTool {
  const originalInvoke = tool.invoke.bind(tool);

  const wrappedTool = Object.create(tool) as StructuredTool;
  wrappedTool.invoke = async (input: unknown, options?: unknown) => {
    const start = Date.now();
    try {
      const output = await originalInvoke(input, options as any);
      recorder.recordCall({
        type: "mcp",
        tool: tool.name,
        input,
        output,
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
      return output;
    } catch (error) {
      recorder.recordCall({
        type: "mcp",
        tool: tool.name,
        input,
        error: String(error),
        durationMs: Date.now() - start,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  };
  return wrappedTool;
}

// ── AWS SDK middleware ────────────────────────────────────────────────────────

/**
 * Adds recording middleware to an AWS SDK v3 client's middleware stack.
 * Captures command name, input, output, duration, and errors.
 */
export function addRecordingMiddleware(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { middlewareStack: { add: (...args: any[]) => void } },
  recorder: RecordingInterceptor,
  serviceName: string,
): void {
  client.middlewareStack.add(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next: any, context: any) => async (args: any) => {
      const start = Date.now();
      const operationName =
        (context as { commandName?: string }).commandName ?? "Unknown";
      try {
        const result = await next(args);
        recorder.recordCall({
          type: "sdk",
          service: serviceName,
          operation: operationName,
          input: (args as { input?: unknown }).input,
          output: (result as { output?: unknown }).output,
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        recorder.recordCall({
          type: "sdk",
          service: serviceName,
          operation: operationName,
          input: (args as { input?: unknown }).input,
          error: String(error),
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
    },
    { step: "deserialize", name: "recordingMiddleware", priority: "low" },
  );
}

// ── LLM recording adapter ───────────────────────────────────────────────────

/**
 * Wraps an LlmPort to record all generateText and generateStructured calls.
 * Pass-through: the inner adapter handles all actual LLM communication.
 */
export class RecordingLlmAdapter implements LlmPort {
  constructor(
    private readonly inner: LlmPort,
    private readonly recorder: RecordingInterceptor,
    private readonly modelName: string = "unknown",
  ) {}

  async generateText(
    prompt: string,
    options?: { maxTokens?: number },
  ): Promise<Result<string, LlmError>> {
    const start = Date.now();
    const result = await this.inner.generateText(prompt, options);
    const [err, text] = result;
    this.recorder.recordCall({
      type: "llm",
      method: "generateText",
      prompt,
      ...(err ? { error: String(err) } : { response: text }),
      model: this.modelName,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: { maxTokens?: number },
  ): Promise<Result<T, LlmError>> {
    const start = Date.now();
    const result = await this.inner.generateStructured(prompt, schema, options);
    const [err, output] = result;
    this.recorder.recordCall({
      type: "llm",
      method: "generateStructured",
      prompt,
      ...(err ? { error: String(err) } : { response: output }),
      model: this.modelName,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
    return result;
  }
}
