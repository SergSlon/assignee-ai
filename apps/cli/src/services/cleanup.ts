/**
 * Re-export barrel for the cleanup pipeline.
 *
 * Split into `./cleanup/` during Wave 6e F3 to enforce the 300-LOC/file
 * rule. External callers and tests continue to import from
 * `../services/cleanup.js` — this file is kept as a thin facade over
 * the new module tree.
 *
 * @see ./cleanup/index.ts
 * @see Story 33.2
 */

export type { CleanupReport, CleanupCategory } from "./cleanup/index.js";
export {
  runFullCleanup,
  runAutoCleanup,
  formatCleanupReport,
} from "./cleanup/index.js";
