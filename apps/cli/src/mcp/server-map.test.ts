/**
 * Tests for command-to-server mapping (Story 29.3).
 * Verifies that each command maps to the correct set of MCP servers
 * and that unknown commands fall back to starting all servers.
 */

import { describe, it, expect } from "vitest";
import { McpServerName } from "../constants/mcp.js";
import { getRequiredServers, COMMAND_SERVER_MAP } from "./server-map.js";

describe("COMMAND_SERVER_MAP", () => {
  // Post acquisition-DD L4-S01 (2026-04-24): KNOWLEDGE removed from plan/apply
  // because the remote knowledge MCP server spawn path was RCE-as-feature-flag.
  // See apps/cli/src/mcp/server-map.ts header for rationale.
  it("plan command maps to exactly 2 servers (pricing, docs)", () => {
    const servers = COMMAND_SERVER_MAP["plan"]!;
    expect(servers).toHaveLength(2);
    expect(servers).toContain(McpServerName.PRICING);
    expect(servers).toContain(McpServerName.DOCS);
    expect(servers).not.toContain(McpServerName.KNOWLEDGE);
  });

  it("apply command maps to the same 2 servers as plan", () => {
    const servers = COMMAND_SERVER_MAP["apply"]!;
    expect(servers).toHaveLength(2);
    expect(servers).toContain(McpServerName.PRICING);
    expect(servers).toContain(McpServerName.DOCS);
    expect(servers).not.toContain(McpServerName.KNOWLEDGE);
  });

  it("status command maps to billing + intelligence servers", () => {
    const servers = COMMAND_SERVER_MAP["status"]!;
    expect(servers).toHaveLength(3);
    expect(servers).toContain(McpServerName.BILLING);
    expect(servers).toContain(McpServerName.IAM);
    expect(servers).toContain(McpServerName.WELL_ARCHITECTED_SECURITY);
  });

  it("list command maps to zero servers (direct SDK)", () => {
    expect(COMMAND_SERVER_MAP["list"]).toEqual([]);
  });

  it("destroy command maps to zero servers (direct SDK)", () => {
    expect(COMMAND_SERVER_MAP["destroy"]).toEqual([]);
  });

  it("init command maps to zero servers (local only)", () => {
    expect(COMMAND_SERVER_MAP["init"]).toEqual([]);
  });

  it("clean command maps to zero servers (local only)", () => {
    expect(COMMAND_SERVER_MAP["clean"]).toEqual([]);
  });

  it("setup command maps to zero servers", () => {
    expect(COMMAND_SERVER_MAP["setup"]).toEqual([]);
  });

  it("completions command maps to zero servers", () => {
    expect(COMMAND_SERVER_MAP["completions"]).toEqual([]);
  });
});

describe("getRequiredServers", () => {
  it("returns server list for known command (plan)", () => {
    const result = getRequiredServers("plan");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result).toContain(McpServerName.PRICING);
  });

  it("returns empty array for zero-server command (list)", () => {
    const result = getRequiredServers("list");
    expect(result).toEqual([]);
  });

  it("returns null for unknown command (fallback to all)", () => {
    const result = getRequiredServers("unknown-command");
    expect(result).toBeNull();
  });

  it("returns null for empty string command", () => {
    const result = getRequiredServers("");
    expect(result).toBeNull();
  });

  describe("startup reduction validation", () => {
    // KNOWLEDGE dropped per L4-S01 (2026-04-24). Core server count now 2.
    const ALL_CORE_SERVERS = 2; // PRICING, DOCS
    const ALL_OPTIONAL_SERVERS = 3; // IAM, WELL_ARCHITECTED_SECURITY, BILLING
    const TOTAL_SERVERS = ALL_CORE_SERVERS + ALL_OPTIONAL_SERVERS; // 5

    it("plan command starts 2/5 servers (60% reduction)", () => {
      const servers = getRequiredServers("plan")!;
      const reduction =
        ((TOTAL_SERVERS - servers.length) / TOTAL_SERVERS) * 100;
      expect(reduction).toBeGreaterThanOrEqual(40);
    });

    it("list command starts 0/5 servers (100% reduction)", () => {
      const servers = getRequiredServers("list")!;
      expect(servers).toHaveLength(0);
      const reduction =
        ((TOTAL_SERVERS - servers.length) / TOTAL_SERVERS) * 100;
      expect(reduction).toBe(100);
    });

    it("destroy command starts 0/5 servers (100% reduction)", () => {
      const servers = getRequiredServers("destroy")!;
      expect(servers).toHaveLength(0);
    });

    it("status command starts 3/5 servers (40% reduction)", () => {
      const servers = getRequiredServers("status")!;
      const reduction =
        ((TOTAL_SERVERS - servers.length) / TOTAL_SERVERS) * 100;
      expect(reduction).toBeGreaterThanOrEqual(40);
    });
  });
});
