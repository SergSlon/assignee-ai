import { describe, it, expect } from "vitest";
import { unwrapMcpText } from "./mcp.js";

describe("unwrapMcpText", () => {
  it("extracts text from { type: 'text', text: '<json>' } wrapper", () => {
    const response = { type: "text", text: '{"key":"value"}' };
    expect(unwrapMcpText(response)).toBe('{"key":"value"}');
  });

  it("extracts text from object with only text property", () => {
    const response = { text: "plain string" };
    expect(unwrapMcpText(response)).toBe("plain string");
  });

  it("returns JSON.stringify for non-object input", () => {
    expect(unwrapMcpText("raw string")).toBe('"raw string"');
  });

  it("returns JSON.stringify for null", () => {
    expect(unwrapMcpText(null)).toBe("null");
  });

  it("returns JSON.stringify for object without text property", () => {
    const response = { data: [1, 2, 3] };
    expect(unwrapMcpText(response)).toBe('{"data":[1,2,3]}');
  });

  it("returns JSON.stringify when text property is not a string", () => {
    const response = { text: 42 };
    expect(unwrapMcpText(response)).toBe('{"text":42}');
  });

  it("extracts result from { result: '...' } wrapper (documentation MCP)", () => {
    const response = { result: "## Section content\n\nSome documentation." };
    expect(unwrapMcpText(response)).toBe(
      "## Section content\n\nSome documentation.",
    );
  });

  it("prefers text over result when both present", () => {
    const response = { text: "from-text", result: "from-result" };
    expect(unwrapMcpText(response)).toBe("from-text");
  });

  it("returns JSON.stringify when result property is not a string", () => {
    const response = { result: { nested: true } };
    expect(unwrapMcpText(response)).toBe('{"result":{"nested":true}}');
  });
});
