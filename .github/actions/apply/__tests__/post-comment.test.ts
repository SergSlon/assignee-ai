import { describe, it, expect } from "vitest";

// ── Import the module under test ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatApplyComment, COMMENT_MARKER } = require("../post-comment.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Apply post-comment", () => {
  describe("formatApplyComment", () => {
    it("includes the HTML marker", () => {
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "",
        rawOutput: "",
      });
      expect(result).toContain(COMMENT_MARKER);
    });

    it("formats a successful apply result with ARN", () => {
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "arn:aws:s3:::my-bucket-12345",
        rawOutput: "",
      });

      expect(result).toContain("Succeeded");
      expect(result).toContain("arn:aws:s3:::my-bucket-12345");
      expect(result).not.toContain("Error Details");
    });

    it("formats a successful apply with cost from JSON output", () => {
      const rawOutput = JSON.stringify({
        status: "success",
        costEstimate: { monthly: "$3.50/mo" },
      });
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "arn:aws:s3:::my-bucket",
        rawOutput,
      });

      expect(result).toContain("$3.50/mo");
      expect(result).toContain("Estimated Monthly Cost");
    });

    it("formats a failed apply result with error details", () => {
      const result = formatApplyComment({
        applyResult: "failed",
        resourceArn: "",
        rawOutput:
          "Error: AccessDenied - insufficient permissions to create S3 bucket",
      });

      expect(result).toContain("Failed");
      expect(result).toContain("Error Details");
      expect(result).toContain("AccessDenied");
    });

    it("truncates very long error output", () => {
      const longOutput = "x".repeat(5000);
      const result = formatApplyComment({
        applyResult: "failed",
        resourceArn: "",
        rawOutput: longOutput,
      });

      // Should be truncated to 3000 chars
      expect(result).toContain("Error Details");
      const codeBlockContent = result.split("```")[1];
      expect(codeBlockContent!.length).toBeLessThanOrEqual(3010); // 3000 + newlines
    });

    it("includes the assignee.ai attribution footer", () => {
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "",
        rawOutput: "",
      });
      expect(result).toContain("assignee.ai");
      expect(result).toContain("GitHub Action");
    });

    it("handles missing resourceArn gracefully", () => {
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "",
        rawOutput: "",
      });

      expect(result).not.toContain("Resource ARN");
    });

    it("shows resource ARN when provided", () => {
      const result = formatApplyComment({
        applyResult: "success",
        resourceArn: "arn:aws:lambda:us-east-1:123456789:function:my-func",
        rawOutput: "",
      });

      expect(result).toContain("Resource ARN");
      expect(result).toContain(
        "arn:aws:lambda:us-east-1:123456789:function:my-func",
      );
    });
  });
});
