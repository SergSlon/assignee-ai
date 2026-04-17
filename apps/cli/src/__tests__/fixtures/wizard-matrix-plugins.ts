/**
 * Thin re-export shim — canonical fixture lives in
 * `packages/core/src/__tests__/fixtures/wizard-matrix-plugins.ts` (Story
 * 50-4 Wave 5 Pass H.2). Moved to core alongside the 3 wizard-matrix
 * tests (companions, intent-rules, bp-hints) relocated in that pass.
 * The 4 remaining wizard-matrix tests in CLI (back-nav, conditionals,
 * fetchers, happy-path) still import from this CLI path; Pass I can
 * collapse them into core alongside the createGraph lift.
 */
export * from "@assignee/core/__tests__/fixtures/wizard-matrix-plugins.js";
