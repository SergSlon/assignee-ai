// Internal helpers shared across the split fixture files.
// Extracted verbatim from the monolith mcp-mock-responses.ts.

/** Wrap a JSON-serializable payload as an MCP text-content block. */
export function mcpText(payload: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(payload) };
}

/** Unwrap an MCP text-content schema response back to a plain object. */
export function unwrapSchemaPayload(response: {
  type: "text";
  text: string;
}): Record<string, unknown> {
  return JSON.parse(response.text) as Record<string, unknown>;
}

/**
 * Wraps a payload in the { result: {...} } envelope that the real
 * iam-mcp-server returns for simulate_principal_policy.
 */
export function iamResultEnvelope(payload: Record<string, unknown>): {
  result: Record<string, unknown>;
} {
  return {
    result: {
      ...payload,
      IsTruncated: false,
      PolicySourceArn: "arn:aws:iam::210987654321:user/assignee-operator",
    },
  };
}

/**
 * Wraps a payload in the { result: {...} } envelope that the real
 * well-architected-security-mcp-server v0.1.7 returns.
 */
export function securityResultEnvelope(payload: unknown): unknown {
  return { result: payload };
}

/**
 * Builds a session-based billing response matching the 0.0.17+ MCP server format.
 * The server returns { status, data: { ..., preview: [{key, value}] } } where
 * ResultsByTime is a JSON-stringified value in the preview array.
 */
export function billingSessionResponse(resultsByTime: unknown[]): {
  status: string;
  data: {
    status: string;
    data_stored: boolean;
    table_name: string;
    schema: string[];
    preview: Array<{ key: string; value: string }>;
  };
} {
  return {
    status: "success",
    data: {
      status: "success",
      data_stored: true,
      table_name: "getCostAndUsage_mock",
      schema: ["key", "value"],
      preview: [
        {
          key: "ResultsByTime",
          value: JSON.stringify(resultsByTime),
        },
      ],
    },
  };
}
