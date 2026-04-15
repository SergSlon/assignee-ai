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
 * Patterns matched against any string value (key-blind) to catch credentials
 * embedded inside larger payloads (e.g. error messages, LLM prompts, ARNs).
 *
 * - AKIA-prefixed access keys (long-term IAM users)
 * - ASIA-prefixed access keys (short-term STS sessions)
 * - IAM ARNs containing 12-digit account IDs
 *
 * @see SECURITY-AUDIT.md — M-S2
 */
const ACCESS_KEY_PATTERN = /(AKIA|ASIA)[0-9A-Z]{16}/g;
// Partition-aware: `arn:aws:`, `arn:aws-us-gov:`, `arn:aws-cn:`, and
// `arn:aws-iso[-b|-e|-f]:` IAM ARNs all embed 12-digit account IDs we
// must redact. Previously `arn:aws:iam::\d{12}:` leaked GovCloud/China/
// ISO account IDs into replay fixtures. Capture the partition so the
// replacement preserves it for debugging without exposing the account.
const IAM_ARN_ACCOUNT_PATTERN = /arn:(aws(?:-[a-z]+)*):iam::\d{12}:/g;

/**
 * Scrub credential-shaped substrings from a single string value.
 * Exported only for testing — production code should use redactSensitive().
 */
export function redactStringValue(value: string): string {
  return value
    .replace(ACCESS_KEY_PATTERN, "[REDACTED-AKIA]")
    .replace(IAM_ARN_ACCOUNT_PATTERN, "arn:$1:iam::[REDACTED]:");
}

/**
 * Recursively redact sensitive keys AND credential-shaped substrings from
 * any value before writing to disk. Returns a new object (does not mutate
 * the original).
 */
function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactStringValue(value);
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

// ── Filename sanitization ────────────────────────────────────────────────────

/** Maximum length per filename segment to keep paths bounded. */
const MAX_FILENAME_SEGMENT_LENGTH = 64;

/**
 * Sanitize a single filename segment by stripping path separators, dots, and
 * any other characters that could escape the parent directory or break the
 * filesystem. Empty results fall back to "unknown".
 *
 * Exported only for testing.
 *
 * @see SECURITY-AUDIT.md — M-S1
 */
export function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment
    .replace(/[/\\.]/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, MAX_FILENAME_SEGMENT_LENGTH);
  return cleaned.length > 0 ? cleaned : "unknown";
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
   *
   * Sanitizes each metadata segment so a malicious upstream (e.g. an MCP
   * server returning a tool name like `../../etc/passwd`) cannot escape
   * the per-runId recording directory.
   *
   * @see SECURITY-AUDIT.md — M-S1 (path traversal hardening)
   */
  private makeFilename(call: RecordedCall): string {
    const ts = sanitizeFilenameSegment(call.timestamp.replace(/[:.]/g, "-"));
    switch (call.type) {
      case "mcp":
        return `mcp-${sanitizeFilenameSegment(call.tool)}-${ts}.json`;
      case "sdk":
        return `sdk-${sanitizeFilenameSegment(call.service)}-${sanitizeFilenameSegment(call.operation)}-${ts}.json`;
      case "llm":
        return `llm-${sanitizeFilenameSegment(call.method)}-${ts}.json`;
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
/**
 * AWS SDK v3 client with a middleware stack we can hook into.
 *
 * REG-N8: The real @aws-sdk/types `MiddlewareStack#add` is a heavily-
 * overloaded generic (Initialize / Serialize / Build / Finalize /
 * Deserialize variants) that no hand-rolled signature can mirror without
 * pulling the full @aws-sdk/types dep — and `unknown[]` rejects at every
 * concrete client we pass through `addRecordingMiddleware` because the SDK
 * declares specific positional types per overload. We therefore intentionally
 * use `any[]` here, with an explicit eslint-disable comment so it cannot be
 * silently re-removed without consideration. Type-safety for our own usage
 * is enforced by the typed callback inside `addRecordingMiddleware` below.
 */
interface SdkClientWithMiddleware {
  middlewareStack: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK v3 MiddlewareStack#add is a heavily overloaded generic; only `any[]` accepts every CloudControl/EC2/STS/etc client without forcing each caller to cast. The lambda passed at the call site below is fully typed via SdkMiddlewareFn so callers still get full safety inside the recorded middleware body.
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
  // Type the recording middleware as the strict SdkMiddlewareFn so the body
  // below has full input/output typing — even though `middlewareStack.add`
  // itself is typed as `(...any[]) => void` to accept every concrete AWS SDK
  // client. (REG-N8)
  const recordingMiddleware: SdkMiddlewareFn =
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
    };
  client.middlewareStack.add(recordingMiddleware, {
    step: "deserialize",
    name: "recordingMiddleware",
    priority: "low",
  });
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
