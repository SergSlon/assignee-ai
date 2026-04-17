/**
 * CloudControlAdapter — thin re-export shim.
 *
 * The implementation lives in `@assignee/core/aws` (lifted in Story 50-4
 * Wave 5.1). Keeping this module file as a re-export means existing CLI
 * imports of "../services/cloudcontrol-adapter.js" keep working without
 * touching every callsite.
 */
export { CloudControlAdapter } from "@assignee/core";
