/**
 * Public barrel for the cleanup pipeline.
 *
 * @see Story 33.2
 */

export type { CleanupReport, CleanupCategory } from "./types.js";
export { runFullCleanup, runAutoCleanup } from "./orchestrator.js";
export { formatCleanupReport } from "./report-formatter.js";
