/**
 * Barrel re-export for the `iam-policies/` module family.
 * Preserves the public surface previously owned by `config/iam-policies.ts`.
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

export * from "./types.js";
export * from "./wildcard-collapser.js";
export * from "./action-collector.js";
export * from "./operator.js";
export * from "./reader.js";
export * from "./auditor.js";
