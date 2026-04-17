/**
 * Org policy SaaS-cached fetcher — thin re-export shim.
 *
 * Canonical implementation lives in `@assignee/core` (lifted in
 * Story 50-4 Wave 5 Pass G so the in-core graph can fetch org policy
 * without reaching back into the CLI app).
 */
export { fetchOrgPolicy, readAuthToken } from "@assignee/core";
