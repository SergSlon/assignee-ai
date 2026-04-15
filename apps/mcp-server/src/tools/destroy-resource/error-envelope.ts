/**
 * MCP tool error/success envelope construction.
 *
 * The MCP SDK expects {content: [{type: "text", text: JSON.stringify(...)}], isError?}.
 * Centralizing the shape keeps response construction DRY and lets the dispatcher
 * stay focused on control flow.
 */

export interface McpToolResponse {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function buildErrorResponse(
  message: string,
  hint?: string,
): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: true,
          message,
          ...(hint ? { hint } : {}),
        }),
      },
    ],
    isError: true,
  };
}

export function buildSuccessResponse(
  payload: Record<string, unknown>,
): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}
