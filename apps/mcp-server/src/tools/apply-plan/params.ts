/**
 * Zod parameter schema for the apply_plan MCP tool.
 *
 * Kept in its own module so the shape can be imported by tests and
 * SDK consumers without dragging in the whole handler + graph
 * runtime.
 *
 * @see Epic 20, Story 20.3, ADR-008
 */

import { z } from "zod";

export const applyPlanParams = {
  checkpointPath: z
    .string()
    .describe("Path to the plan checkpoint file (returned by plan_resource)."),
  confirmed: z
    .boolean()
    .describe(
      "Safety gate — must be true to proceed with provisioning. Set to false for a dry-run check.",
    ),
};
