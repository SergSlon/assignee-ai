/**
 * Tests for security-posture.ts — checkSecurityPosture utility.
 *
 * Covers the enabled=false short-circuit path using the real
 * McpMocks.security.serviceDisabled fixture.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkSecurityPosture } from "./security-posture.js";
import {
  McpMocks,
  createSecurityMockTool,
} from "../test-fixtures/mcp-mock-responses.js";

// Mock renderSecurityWarnings to verify it is NOT called
vi.mock("./display.js", () => ({
  renderSecurityWarnings: vi.fn(),
}));

import { renderSecurityWarnings } from "./display.js";

const mockRenderWarnings = vi.mocked(renderSecurityWarnings);

describe("checkSecurityPosture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns without rendering warnings when the security service is disabled (enabled=false)", async () => {
    const tool = createSecurityMockTool(
      McpMocks.security.serviceDisabled.success,
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await checkSecurityPosture(
      "arn:aws:s3:::my-production-bucket",
      [tool],
      "run-00000000-0000-0000-0000-000000000001",
    );

    // enabled=false should short-circuit — no warnings rendered, no errors
    expect(mockRenderWarnings).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("MCP server unavailable"),
    );

    stderrSpy.mockRestore();
  });
});
