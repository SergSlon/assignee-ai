/**
 * Tests for MCP server configuration (Story 19.7 — billing server registration).
 *
 * Verifies:
 * - BILLING constant is defined in McpServerName
 * - Billing server appears in getOptionalMcpServerConfigs() output
 * - Billing server uses mcpEnv() for credentials
 */

import { describe, it, expect } from "vitest";
import { McpServerName, McpCommand } from "../constants/mcp.js";
import { getOptionalMcpServerConfigs } from "./mcp-servers.js";

describe("McpServerName", () => {
  it("defines the BILLING constant", () => {
    expect(McpServerName.BILLING).toBe("aws-cost-management-mcp-server");
  });
});

describe("getOptionalMcpServerConfigs", () => {
  it("includes the billing server", () => {
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.BILLING]).toBeDefined();
  });

  it("billing server uses uvx command", () => {
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING];
    expect(billing!.command).toBe(McpCommand.UVX);
  });

  it("billing server uses the correct package name", () => {
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING];
    expect(billing!.args).toContain(
      "awslabs.cost-management-mcp-server@latest",
    );
  });

  it("billing server uses mcpEnv() credentials (AWS_ACCESS_KEY_ID present)", () => {
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING];
    expect(billing!.env).toBeDefined();
    expect(billing!.env).toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(billing!.env).toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(billing!.env).toHaveProperty("AWS_DEFAULT_REGION");
  });

  it("still includes IAM and Well-Architected Security servers", () => {
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.IAM]).toBeDefined();
    expect(configs[McpServerName.WELL_ARCHITECTED_SECURITY]).toBeDefined();
  });
});
