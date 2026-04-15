/**
 * Non-interactive output helpers for Assignee.ai CLI.
 *
 * This file is now a thin re-export barrel — implementations live in
 * ./display-output/ split by concern (spinner, intro/outro, error,
 * apply-success, compound-success, compound-failure, security-warnings,
 * dependency-plan, resource-table, status-summary). See ./display-output/index.ts.
 */
export * from "./display-output/index.js";
