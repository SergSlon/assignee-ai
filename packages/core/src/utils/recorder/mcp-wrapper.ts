/**
 * StructuredTool wrapper that forwards MCP invocations to a RecordingInterceptor.
 *
 * Lifted from `apps/cli/src/utils/recorder/mcp-wrapper.ts` in Story 50-4
 * Wave 5 Pass A.
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { RecordingInterceptor } from "./session.js";

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
