/**
 * Backward-compat barrel for `apps/cli/src/config/constants.ts`.
 *
 * As of Story 49.5 the constants previously exported from this file
 * live in domain-oriented sub-modules under `config/constants/`:
 *   - aws.ts       — AWS region, service IDs, credential error messages
 *   - timeouts.ts  — polling caps, retry intervals, TTLs
 *   - limits.ts    — size limits, memory caps, pricing-calc constants
 *   - paths.ts     — filesystem paths + filename constants
 *   - ui.ts        — user-facing messages, boxen styling
 *   - help.ts      — long-form help text blocks
 *   - enums.ts     — named magic-string enums (Promise, Cleanup, ...)
 *   - security.ts  — security-sensitive constants
 *   - saas.ts      — Bedrock model, SaaS API URL
 *
 * NEW CODE: import directly from the matching sub-module instead of
 * this barrel. Using the barrel is tolerated for backward compat but
 * actively discouraged — the old 113-importer coupling hub was
 * flagged by the code audit (Story 49.5).
 */

// Preserve the SUPPORTED_TYPES re-export that the rest of the CLI
// historically pulled from this module (Story 9.1 single-source-of-truth).
export { SUPPORTED_TYPES_ARRAY as SUPPORTED_TYPES } from "@assignee/core";

export * from "./constants/aws.js";
export * from "./constants/timeouts.js";
export * from "./constants/limits.js";
export * from "./constants/paths.js";
export * from "./constants/ui.js";
export * from "./constants/help.js";
export * from "./constants/enums.js";
export * from "./constants/security.js";
export * from "./constants/saas.js";
