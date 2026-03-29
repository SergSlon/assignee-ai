/**
 * Tests for MCP server configuration.
 *
 * Story 19.7 — billing server registration.
 * Core MCP servers: Pricing + Docs. Optional: Knowledge, IAM, WA-Security, Billing.
 *
 * Verifies:
 * - getMcpServerConfigs() returns exactly 3 core servers (Knowledge, Pricing, Docs)
 * - No deprecated server references
 * - IAC constant no longer exists on McpServerName
 * - BILLING constant is defined in McpServerName
 * - Billing server appears in getOptionalMcpServerConfigs() output
 * - Billing server uses mcpEnv() for credentials
 */

import { describe, it, expect } from "vitest";
import { McpServerName, McpCommand } from "../constants/mcp.js";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
} from "./mcp-servers.js";

describe("McpServerName", () => {
  it("defines the BILLING constant", () => {
    expect(McpServerName.BILLING).toBe("aws-cost-management-mcp-server");
  });

  it("does not define IAC constant (removed in Story 31.4)", () => {
    expect("IAC" in McpServerName).toBe(false);
  });
});

describe("getMcpServerConfigs", () => {
  it("returns exactly 2 core servers (Pricing, Docs)", () => {
    const configs = getMcpServerConfigs();
    expect(Object.keys(configs)).toHaveLength(2);
  });

  it("includes Pricing and Docs servers", () => {
    const configs = getMcpServerConfigs();
    expect(configs[McpServerName.PRICING]).toBeDefined();
    expect(configs[McpServerName.DOCS]).toBeDefined();
  });

  it("Knowledge server is optional (not core)", () => {
    const core = getMcpServerConfigs();
    const optional = getOptionalMcpServerConfigs();
    expect(core[McpServerName.KNOWLEDGE]).toBeUndefined();
    expect(optional[McpServerName.KNOWLEDGE]).toBeDefined();
  });

  it("does not include cfn-mcp-server in any entry", () => {
    const configs = getMcpServerConfigs();
    for (const [name, config] of Object.entries(configs)) {
      expect(name).not.toContain("cfn-mcp-server");
      expect(config.args.join(" ")).not.toContain("cfn-mcp-server");
    }
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
