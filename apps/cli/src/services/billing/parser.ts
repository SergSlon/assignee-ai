/**
 * Billing MCP response parsers — extract ResultsByTime and the generic
 * session-based `preview` key-value bag from billing-cost-management-mcp-
 * server@0.0.17+ responses.
 *
 * All catches route through logBillingMcpFailure (zero bare catches).
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 */

import { logBillingMcpFailure } from "./error-handler.js";

/**
 * Extracts ResultsByTime from the new session-based MCP response format.
 *
 * The billing-cost-management-mcp-server@0.0.17+ returns:
 *   { status: "success",
 *     data: { ...,
 *       preview: [{ key: "ResultsByTime", value: "<JSON string>" }, ...] } }
 */
export function extractResultsByTime(response: unknown): unknown[] {
  if (typeof response !== "object" || response === null) return [];

  // Unwrap MCP text wrapper ({ type: "text", text: "<JSON>" }) if present
  let resp = response as Record<string, unknown>;
  if ("text" in resp && typeof resp["text"] === "string") {
    try {
      resp = JSON.parse(resp["text"] as string) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractResultsByTime.parseTextWrapper", err);
      return [];
    }
  }
  // Also handle string responses (unwrapMcpText output)
  if (typeof resp === "string") {
    try {
      resp = JSON.parse(resp) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractResultsByTime.parseStringResponse", err);
      return [];
    }
  }

  // New session-based format: data.preview contains key-value pairs
  const data = resp["data"] as Record<string, unknown> | undefined;
  const preview = data?.["preview"];
  if (Array.isArray(preview)) {
    const rtEntry = (preview as Array<{ key: string; value: string }>).find(
      (p) => p.key === "ResultsByTime",
    );
    if (rtEntry) {
      try {
        const parsed = JSON.parse(rtEntry.value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        logBillingMcpFailure("extractResultsByTime.parseResultsByTime", err);
        return [];
      }
    }
  }

  return [];
}

/**
 * Extracts preview data from a session-based Billing MCP response.
 * Handles the standard wrapper: {status:"success", data:{preview:[{key,value}]}}
 */
export function extractPreviewData(response: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof response !== "object" || response === null) return result;

  let resp = response as Record<string, unknown>;
  if ("text" in resp && typeof resp["text"] === "string") {
    try {
      resp = JSON.parse(resp["text"] as string) as Record<string, unknown>;
    } catch (err) {
      logBillingMcpFailure("extractPreviewData.parseTextWrapper", err);
      return result;
    }
  }

  const data = resp["data"] as Record<string, unknown> | undefined;
  const preview = data?.["preview"];
  if (Array.isArray(preview)) {
    for (const entry of preview as Array<{ key: string; value: string }>) {
      if (entry.key && entry.value) {
        result[entry.key] = entry.value;
      }
    }
  }
  return result;
}
