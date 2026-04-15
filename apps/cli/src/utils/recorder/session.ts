/**
 * RecordingInterceptor — session-store for captured calls.
 *
 * Extracted from recorder.ts (Wave 6d F5). Applies redaction per
 * feedback_redaction_allowlist_not_denylist before persisting any call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { EnvVar } from "../../constants/env-vars.js";
import type { RecordedCall, RecordingManifest } from "./types.js";
import { redactSensitive } from "./redaction.js";
import { getRecordingDir, sanitizeFilenameSegment } from "./paths.js";

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

  /** Lazily ensures the recording directory exists. */
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
   * to never impact CLI behavior. Sensitive fields are redacted before writing.
   */
  recordCall(call: RecordedCall): void {
    try {
      this.ensureDir();
      const filename = this.makeFilename(call);
      const filePath = path.join(this.dir, filename);
      const sanitized = redactSensitive(call);
      fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2) + "\n");
      this.files.push(filename);
    } catch {
      // Recording is best-effort — never fail the CLI
    }
  }

  /** Writes `_manifest.json` summarizing all recorded files. */
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

/** Returns true when ASSIGNEE_RECORD=1 is set in the environment. */
export function isRecordingEnabled(): boolean {
  return process.env[EnvVar.ASSIGNEE_RECORD] === "1";
}
