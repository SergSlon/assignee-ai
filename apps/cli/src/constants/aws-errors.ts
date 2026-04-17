/**
 * AwsErrorName — thin re-export shim.
 *
 * The canonical const lives in `@assignee/core` (lifted in Story 50-4
 * Wave 5.1 to packages/core/src/constants/aws-error-names.ts) so the
 * in-core CloudControlAdapter and graph nodes can use it without
 * reaching back into the CLI app.
 */
export { AwsErrorName } from "@assignee/core";
