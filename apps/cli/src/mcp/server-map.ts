/**
 * Command-to-MCP-server mapping for lazy loading.
 *
 * Defines which MCP servers each CLI command needs. Commands not listed
 * (or mapped to an empty array) spawn zero MCP server processes.
 * Unknown commands fall back to starting all servers for safety.
 *
 * @see Story 29.3 — MCP Server Lazy Loading
 */

import { McpServerName, type McpServerNameType } from "../constants/mcp.js";

/**
 * Maps each CLI command name to the MCP server names it requires.
 *
 * - Core servers (KNOWLEDGE, PRICING, DOCS) are started per command need.
 * - Optional servers (IAM, WELL_ARCHITECTED_SECURITY, BILLING) are listed
 *   where needed; the MCP client handles their graceful degradation.
 *
 * Drift/reconcile commands use direct SDK (no MCP servers needed).
 * Optimize command (Epic 32) is deferred to Phase 3.
 */
export const COMMAND_SERVER_MAP: Record<string, McpServerNameType[]> = {
  // plan + apply need pricing, knowledge, and docs for schema/cost/documentation lookups
  plan: [McpServerName.PRICING, McpServerName.KNOWLEDGE, McpServerName.DOCS],
  apply: [McpServerName.PRICING, McpServerName.KNOWLEDGE, McpServerName.DOCS],

  // status uses billing + optional intelligence servers (direct SDK, no core MCP)
  status: [
    McpServerName.BILLING,
    McpServerName.IAM,
    McpServerName.WELL_ARCHITECTED_SECURITY,
  ],

  // Direct SDK commands — no MCP servers needed
  list: [],
  destroy: [],
  clean: [],
  init: [],
  setup: [],
  completions: [],

  // drift: [] — uses direct CCAPI SDK, no MCP servers needed
  drift: [],
  // A7 (2026-04-08) — optimize only needs the Pricing MCP to compare
  // current instance prices against cheaper alternatives. All other
  // work (resource enumeration, desiredState lookup) is direct SDK.
  optimize: [McpServerName.PRICING],
};

/**
 * Returns the list of MCP server names required by the given command.
 *
 * - Known commands return their mapped server list (may be empty).
 * - Unknown commands return `null`, signaling the caller to start all servers
 *   as a safe fallback.
 *
 * @param command - The CLI command name (e.g. "plan", "list").
 * @returns Array of server names, or null for unknown commands (start all).
 */
export function getRequiredServers(
  command: string,
): McpServerNameType[] | null {
  if (command in COMMAND_SERVER_MAP) {
    return COMMAND_SERVER_MAP[command]!;
  }
  // Unknown command — caller should start all servers as fallback
  return null;
}
