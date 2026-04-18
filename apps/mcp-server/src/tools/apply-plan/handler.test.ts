import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../utils/structured-log.js", () => ({
  mcpLogWarn: vi.fn(),
  mcpLog: vi.fn(),
}));

import { mcpLogWarn } from "../../utils/structured-log.js";
import { extractAuditIdentifier } from "./handler.js";

describe("extractAuditIdentifier", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns the resourceArn from a well-formed JSON envelope", () => {
    const envelope = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            resourceArn: "arn:aws:s3:::my-bucket-produced-by-apply-plan",
          }),
        },
      ],
    };
    const id = extractAuditIdentifier(envelope);
    expect(id).toBe("arn:aws:s3:::my-bucket-produced-by-apply-plan");
    expect(mcpLogWarn).not.toHaveBeenCalled();
  });

  it("returns empty string when content is missing", () => {
    const id = extractAuditIdentifier({ content: [] });
    expect(id).toBe("");
    expect(mcpLogWarn).not.toHaveBeenCalled();
  });

  it("returns empty string when content[0].text is non-string", () => {
    const id = extractAuditIdentifier({
      content: [
        {
          type: "text" as const,
          text: undefined as unknown as string,
        },
      ],
    });
    expect(id).toBe("");
    expect(mcpLogWarn).not.toHaveBeenCalled();
  });

  it("returns empty string when resourceArn is missing from JSON", () => {
    const envelope = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: true, message: "no arn here" }),
        },
      ],
    };
    const id = extractAuditIdentifier(envelope);
    expect(id).toBe("");
    expect(mcpLogWarn).not.toHaveBeenCalled();
  });

  it("returns empty string when resourceArn is non-string", () => {
    const envelope = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ resourceArn: 42 }),
        },
      ],
    };
    const id = extractAuditIdentifier(envelope);
    expect(id).toBe("");
    expect(mcpLogWarn).not.toHaveBeenCalled();
  });

  it("logs a warning and returns empty string on malformed JSON (Wave L2 fix)", () => {
    const envelope = {
      content: [
        {
          type: "text" as const,
          text: "this is NOT JSON {{{{",
        },
      ],
    };
    const id = extractAuditIdentifier(envelope);
    expect(id).toBe("");
    expect(mcpLogWarn).toHaveBeenCalledOnce();
    const [source, action, extras, message] =
      vi.mocked(mcpLogWarn).mock.calls[0]!;
    expect(source).toBe("apply-plan/handler");
    expect(action).toBe("extract-audit-identifier-parse-fail");
    expect(extras).toMatchObject({
      error: expect.any(String),
      textSnippet: "this is NOT JSON {{{{",
    });
    expect(message).toContain("JSON");
  });

  it("truncates the textSnippet to 200 chars for malformed JSON", () => {
    const longText = "broken JSON ".repeat(100); // 1200 chars, definitely not parseable
    const envelope = {
      content: [{ type: "text" as const, text: longText }],
    };
    extractAuditIdentifier(envelope);
    expect(mcpLogWarn).toHaveBeenCalledOnce();
    const [, , extras] = vi.mocked(mcpLogWarn).mock.calls[0]!;
    expect((extras as { textSnippet: string }).textSnippet.length).toBe(200);
  });
});
