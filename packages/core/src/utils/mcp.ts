/**
 * MCP response utilities.
 *
 * Active MCP servers return responses in two formats:
 * - { type: "text", text: "<json>" } — content block wrapper (pricing, schema, knowledge)
 * - { result: "<content>" } — direct result wrapper (documentation read_sections, read_documentation)
 *
 * unwrapMcpText() extracts the text content ready for JSON.parse().
 */

/**
 * Extracts the text content from an MCP tool response.
 * Handles both { type: "text", text: "<json>" } content block wrappers
 * and { result: "<content>" } direct result wrappers (aws-documentation-mcp-server).
 */
export function unwrapMcpText(response: unknown): string {
  if (typeof response === "object" && response !== null) {
    if (
      "text" in response &&
      typeof (response as { text: unknown }).text === "string"
    ) {
      return (response as { text: string }).text;
    }
    if (
      "result" in response &&
      typeof (response as { result: unknown }).result === "string"
    ) {
      return (response as { result: string }).result;
    }
  }
  return JSON.stringify(response);
}
