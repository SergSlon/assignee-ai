/**
 * MCP response type definitions and type guards.
 * Anti-corruption layer — isolates MCP wire format from business logic.
 */

export interface McpSearchResult {
  url: string;
}

export interface McpSearchResponse {
  structuredContent?: {
    search_results: McpSearchResult[];
  };
  search_results?: McpSearchResult[];
}

/**
 * Validates an array of search result items.
 */
function isSearchResultArray(results: unknown): results is McpSearchResult[] {
  return (
    Array.isArray(results) &&
    results.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        "url" in r &&
        typeof (r as McpSearchResult).url === "string",
    )
  );
}

/**
 * Type guard for MCP search responses.
 * Handles both nested `{ structuredContent: { search_results } }` and
 * top-level `{ search_results }` formats (aws-documentation-mcp-server).
 */
export function isMcpSearchResponse(v: unknown): v is McpSearchResponse {
  if (typeof v !== "object" || v === null) return false;

  // Top-level search_results (real aws-documentation-mcp-server format)
  if ("search_results" in v) {
    return isSearchResultArray(
      (v as { search_results: unknown }).search_results,
    );
  }

  // Nested under structuredContent (legacy format)
  if ("structuredContent" in v) {
    const sc = (v as { structuredContent: unknown }).structuredContent;
    if (typeof sc !== "object" || sc === null || !("search_results" in sc))
      return false;
    return isSearchResultArray(
      (sc as { search_results: unknown }).search_results,
    );
  }

  return false;
}

/** Extracts the first documentation URL from a search response. */
export function extractFirstUrl(response: unknown): string | null {
  if (isMcpSearchResponse(response)) {
    const results =
      response.search_results ??
      response.structuredContent?.search_results ??
      [];
    const url = results.at(0)?.url;
    if (url) return url;
  }
  // Fallback: scan stringified response for an AWS documentation URL
  const match = JSON.stringify(response).match(
    /https?:\/\/docs\.aws\.amazon\.com[^\s\)\"\\,;!]+/,
  );
  return match?.[0] ?? null;
}
