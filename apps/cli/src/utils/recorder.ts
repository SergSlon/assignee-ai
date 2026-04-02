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
import { CfnKey } from "@assignee/core";
import type { LlmPort, Result, LlmError } from "@assignee/core";
import { EnvVar } from "../constants/env-vars.js";
import { UNKNOWN_FALLBACK } from "../config/constants.js";
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

// ── Sensitive data redaction ──────────────────────────────────────────────────

/**
 * Keys whose values must be redacted from recorded fixtures.
 * Prevents accidental credential leakage in test recordings.
 * @see SECURITY-AUDIT.md — SEC-03
 */
const REDACTED_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  CfnKey.MASTER_USER_PASSWORD,
  CfnKey.SECRET_STRING,
  CfnKey.PASSWORD,
  "accessToken",
  "secretAccessKey",
  "sessionToken",
]);

/**
 * Recursively redact sensitive keys from an object before writing to disk.
 * Returns a new object (does not mutate the original).
 */
function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k) && typeof v === "string") {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactSensitive(v);
      }
    }
    return result;
  }
  return value;
}

// ── Env check ────────────────────────────────────────────────────────────────

/**
 * Returns true when ASSIGNEE_RECORD=1 is set in the environment.
 * All recording logic is gated behind this check.
 */
export function isRecordingEnabled(): boolean {
  return process.env[EnvVar.ASSIGNEE_RECORD] === "1";
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
   * Sensitive fields (credentials, passwords, tokens) are redacted before writing.
   */
  recordCall(call: RecordedCall): void {
    try {
      this.ensureDir();
      const filename = this.makeFilename(call);
      const filePath = path.join(this.dir, filename);
      // Redact sensitive data before writing to disk
      const sanitized = redactSensitive(call);
      fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2) + "\n");
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
  wrappedTool.invoke = async (
    input: unknown,
    options?: Parameters<typeof originalInvoke>[1],
  ) => {
    const start = Date.now();
    try {
      const output = await originalInvoke(input, options);
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

/** Minimal types for AWS SDK v3 middleware (avoids @smithy/types dependency). */
interface SdkMiddlewareArgs {
  input?: unknown;
}
interface SdkMiddlewareResult {
  output?: unknown;
}
interface SdkMiddlewareContext {
  commandName?: string;
}
type SdkNextHandler = (args: SdkMiddlewareArgs) => Promise<SdkMiddlewareResult>;
type SdkMiddlewareFn = (
  next: SdkNextHandler,
  context: SdkMiddlewareContext,
) => (args: SdkMiddlewareArgs) => Promise<SdkMiddlewareResult>;
/** AWS SDK v3 client with a middleware stack we can hook into. */
interface SdkClientWithMiddleware {
  middlewareStack: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK v3 middleware stack has complex overloaded signatures not worth replicating
    add: (...args: any[]) => void;
  };
}

/**
 * Adds recording middleware to an AWS SDK v3 client's middleware stack.
 * Captures command name, input, output, duration, and errors.
 */
export function addRecordingMiddleware(
  client: SdkClientWithMiddleware,
  recorder: RecordingInterceptor,
  serviceName: string,
): void {
  client.middlewareStack.add(
    (next: SdkNextHandler, context: SdkMiddlewareContext) =>
      async (args: SdkMiddlewareArgs) => {
        const start = Date.now();
        const operationName = context.commandName ?? "Unknown";
        try {
          const result = await next(args);
          recorder.recordCall({
            type: "sdk",
            service: serviceName,
            operation: operationName,
            input: args.input,
            output: result.output,
            durationMs: Date.now() - start,
            timestamp: new Date().toISOString(),
          });
          return result;
        } catch (error) {
          recorder.recordCall({
            type: "sdk",
            service: serviceName,
            operation: operationName,
            input: args.input,
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
    private readonly modelName: string = UNKNOWN_FALLBACK,
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
