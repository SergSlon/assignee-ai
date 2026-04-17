/**
 * Structured warn-level log helper shared by concrete destroy strategies.
 *
 * Originally lived at apps/cli/src/services/destroy-strategies/helpers.ts;
 * lifted into core by Story 50-4 so both apps/cli and apps/mcp-server
 * register the same concrete strategy files without app-specific imports.
 *
 * destroy-service has no LangGraph runId plumbed in, so we emit a plain
 * JSON object on stderr (matching the shape of the main logger) rather
 * than depending on a CLI-specific logger that requires an action enum
 * value.
 */

export function warnDestroy(
  action: string,
  extras: Record<string, unknown>,
): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        source: "destroy-service",
        action,
        extras,
      }) + "\n",
    );
  } catch {
    // stderr write failures are swallowed — never let logging break destroy.
  }
}
