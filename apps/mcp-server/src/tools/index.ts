/**
 * Tool registration barrel — registers all 4 MCP tools on the server.
 *
 * @see Epic 20, ADR-008
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GraphContext } from "../services/graph-init.js";
import { registerPlanResource } from "./plan-resource.js";
import { registerApplyPlan } from "./apply-plan.js";
import { registerListManagedResources } from "./list-managed-resources.js";
import { registerEstimateCost } from "./estimate-cost.js";

export function registerTools(server: McpServer, ctx?: GraphContext): void {
  registerPlanResource(server, ctx);
  registerApplyPlan(server, ctx);
  registerListManagedResources(server);
  registerEstimateCost(server);
}
