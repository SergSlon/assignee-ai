/**
 * MCP response type definitions and type guards.
 * Anti-corruption layer — isolates MCP wire format from business logic.
 */

export interface McpSearchResult {
  url: string;
}

export interface McpSearchResponse {
  structuredContent: {
    search_results: McpSearchResult[];
  };
}

export function isMcpSearchResponse(v: unknown): v is McpSearchResponse {
  if (typeof v !== "object" || v === null || !("structuredContent" in v))
    return false;
  const sc = (v as { structuredContent: unknown }).structuredContent;
  if (typeof sc !== "object" || sc === null || !("search_results" in sc))
    return false;
  const results = (sc as { search_results: unknown }).search_results;
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

/** Extracts the first documentation URL from a search response. */
export function extractFirstUrl(response: unknown): string | null {
  if (isMcpSearchResponse(response)) {
    const url = response.structuredContent.search_results.at(0)?.url;
    if (url) return url;
  }
  // Fallback: scan stringified response for an AWS documentation URL
  const match = JSON.stringify(response).match(
    /https?:\/\/docs\.aws\.amazon\.com[^\s\)\"\\,;!]+/,
  );
  return match?.[0] ?? null;
}
