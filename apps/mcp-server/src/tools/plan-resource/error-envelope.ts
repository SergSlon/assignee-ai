/**
 * MCP tool envelope builders for the `plan_resource` tool.
 *
 * Mirrors the destroy-resource envelope module (Epic 53 Story 09) so
 * every plan-phase helper can build responses through a single DRY
 * surface. The MCP SDK expects
 * `{content: [{type:"text", text: JSON.stringify(...)}], isError?}` —
 * centralizing the shape keeps the step helpers focused on control
 * flow, not response plumbing.
 */

import type { McpToolResponse } from "../destroy-resource/error-envelope.js";

export type { McpToolResponse };

/** Structured JSON error response. Always sets `isError: true`. */
export function buildPlanErrorResponse(
  payload: Record<string, unknown>,
): McpToolResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, ...payload }),
      },
    ],
    isError: true,
  };
}

/** Structured JSON success response. */
export function buildPlanSuccessResponse(
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
