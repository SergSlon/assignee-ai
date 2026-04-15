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

/**
 * Structured error codes surfaced by the destroy_resource tool. Keep in
 * sync with the troubleshooting doc under "MCP server error classes".
 */
export const DESTROY_ERROR_CODES = {
  /**
   * The pre-delete re-verification found the managed-by tag gone after
   * resolve.time verification succeeded. Indicates a TOCTOU attack (or an
   * operator concurrently untagging). Delete was refused.
   */
  TOCTOU_TAG_MISSING: "DESTROY_TOCTOU_TAG_MISSING",
} as const;

export type DestroyErrorCode =
  (typeof DESTROY_ERROR_CODES)[keyof typeof DESTROY_ERROR_CODES];

export function buildErrorResponse(
  message: string,
  hint?: string,
  code?: DestroyErrorCode,
): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: true,
          message,
          ...(hint ? { hint } : {}),
          ...(code ? { code } : {}),
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
