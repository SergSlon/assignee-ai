/**
 * Environment variable name constants — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core` (lifted in
 * Story 50-4 Wave 5 Pass A so the in-core logger / token-usage /
 * otel-exporter / recorder / LlmAdapter — all EnvVar consumers — can
 * use it without reaching back into the CLI app).
 *
 * @see Story 42.10 — zero magic strings policy
 */
export { EnvVar } from "@assignee/core";
