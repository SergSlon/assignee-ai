/**
 * MCP response utilities.
 *
 * All active MCP servers (aws-iac-mcp-server, aws-pricing-mcp-server,
 * aws-knowledge-mcp-server, aws-documentation-mcp-server) return responses
 * in the { type: "text", text: "<json>" } content block format.
 *
 * unwrapMcpText() extracts the text content ready for JSON.parse().
 */

/**
 * Extracts the text content from an MCP tool response.
 * Handles { type: "text", text: "<json>" } content block wrappers.
 */
export function unwrapMcpText(response: unknown): string {
  if (
    typeof response === "object" &&
    response !== null &&
    "text" in response &&
    typeof (response as { text: unknown }).text === "string"
  ) {
    return (response as { text: string }).text;
  }
  return JSON.stringify(response);
}
