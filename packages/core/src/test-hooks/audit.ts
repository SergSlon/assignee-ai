/**
 * Test-only hooks for the audit subsystem.
 *
 * This module is intentionally excluded from the `@assignee/core/audit`
 * public barrel so that test-internal reset helpers do not pollute the
 * production API surface.
 *
 * Import path: `@assignee/core/test-hooks/audit`
 *
 * Usage (test files only):
 *   import { _resetAuditKeyCache } from "@assignee/core/test-hooks/audit";
 */
export { _resetAuditKeyCache } from "../audit/hmac-chain.js";
