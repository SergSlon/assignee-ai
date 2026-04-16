/**
 * Structured stderr logger for the MCP server.
 *
 * Emits JSON-lines records (one object per `\n`) so log scrapers can
 * normalize MCP output against the CLI's `warnDestroy`/`log()` shape.
 * Never logs to stdout — the MCP protocol uses stdout for tool
 * responses.
 *
 * @see Story 49.7 (Epic 49) — replace console.error/warn in MCP
 * production code with structured log records.
 */

export type McpLogLevel = "info" | "warn" | "error";

export interface McpLogRecord {
  level: McpLogLevel;
  source: string;
  action: string;
  extras?: Record<string, unknown>;
  message?: string;
}

/**
 * Emit a single JSON-line log record to stderr. All stderr write
 * failures are swallowed — never let logging break a tool response.
 */
export function mcpLog(record: McpLogRecord): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        ...record,
      }) + "\n",
    );
  } catch {
    // Best-effort — a failed stderr write must not bubble up.
  }
}

/** Convenience helpers that fill in the `level` field. */
export function mcpLogInfo(
  source: string,
  action: string,
  extras?: Record<string, unknown>,
  message?: string,
): void {
  mcpLog({ level: "info", source, action, extras, message });
}

export function mcpLogWarn(
  source: string,
  action: string,
  extras?: Record<string, unknown>,
  message?: string,
): void {
  mcpLog({ level: "warn", source, action, extras, message });
}

export function mcpLogError(
  source: string,
  action: string,
  extras?: Record<string, unknown>,
  message?: string,
): void {
  mcpLog({ level: "error", source, action, extras, message });
}
