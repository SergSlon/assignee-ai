import { describe, it, expect } from "vitest";
import { isMcpSearchResponse, extractFirstUrl } from "./mcp-types.js";

describe("isMcpSearchResponse", () => {
  it("returns true for valid search response", () => {
    const response = {
      structuredContent: {
        search_results: [{ url: "https://docs.aws.amazon.com/s3" }],
      },
    };
    expect(isMcpSearchResponse(response)).toBe(true);
  });

  it("returns true for empty search results", () => {
    const response = {
      structuredContent: { search_results: [] },
    };
    expect(isMcpSearchResponse(response)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isMcpSearchResponse(null)).toBe(false);
  });

  it("returns false for missing structuredContent", () => {
    expect(isMcpSearchResponse({ data: [] })).toBe(false);
  });

  it("returns false for missing search_results", () => {
    expect(isMcpSearchResponse({ structuredContent: {} })).toBe(false);
  });

  it("returns false for non-object search result items", () => {
    const response = {
      structuredContent: { search_results: ["not-an-object"] },
    };
    expect(isMcpSearchResponse(response)).toBe(false);
  });

  it("returns true for top-level search_results (real documentation MCP format)", () => {
    const response = {
      query_id: "q-001",
      search_results: [{ url: "https://docs.aws.amazon.com/s3" }],
      facets: {},
    };
    expect(isMcpSearchResponse(response)).toBe(true);
  });

  it("returns true for top-level empty search_results", () => {
    const response = { search_results: [] };
    expect(isMcpSearchResponse(response)).toBe(true);
  });

  it("returns false for top-level search_results with invalid items", () => {
    const response = { search_results: [{ title: "no url" }] };
    expect(isMcpSearchResponse(response)).toBe(false);
  });
});

describe("extractFirstUrl", () => {
  it("extracts URL from structured search response", () => {
    const response = {
      structuredContent: {
        search_results: [{ url: "https://docs.aws.amazon.com/s3/latest" }],
      },
    };
    expect(extractFirstUrl(response)).toBe(
      "https://docs.aws.amazon.com/s3/latest",
    );
  });

  it("extracts URL from top-level search_results (real documentation MCP format)", () => {
    const response = {
      query_id: "q-001",
      search_results: [
        { url: "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html" },
      ],
      facets: {},
    };
    expect(extractFirstUrl(response)).toBe(
      "https://docs.aws.amazon.com/lambda/latest/dg/welcome.html",
    );
  });

  it("falls back to regex scan for unstructured response", () => {
    const response = {
      text: "See https://docs.aws.amazon.com/lambda for details",
    };
    expect(extractFirstUrl(response)).toBe(
      "https://docs.aws.amazon.com/lambda",
    );
  });

  it("returns null when no URL found", () => {
    expect(extractFirstUrl({ data: "no url here" })).toBeNull();
  });
});
