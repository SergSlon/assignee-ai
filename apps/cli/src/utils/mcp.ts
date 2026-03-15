/**
 * MCP response utilities.
 *
 * MCP servers return responses in different formats depending on the server:
 *   - aws-iac-mcp-server, aws-pricing-mcp-server: { type: "text", text: "<json>" }
 *   - ccapi-mcp-server: plain JSON string
 *
 * unwrapMcpText() normalises both shapes into a raw string ready for JSON.parse().
 */

/**
 * Extracts the text content from an MCP tool response.
 * Handles both { type: "text", text: "<json>" } wrappers and plain strings.
 */
export function unwrapMcpText(response: unknown): string {
  const raw = response as Record<string, unknown>;
  if (typeof raw?.["text"] === "string") return raw["text"];
  if (typeof response === "string") return response;
  return JSON.stringify(response);
}
