/**
 * AWS-related constants — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core`
 * (lifted in Story 50-4 Wave 5 Pass A so the in-core LlmAdapter,
 * logger, and token-usage accumulator can read AWS_REGION without
 * reaching back into the CLI app).
 *
 * AWS_SERVICE_EXECUTE_API is already exported from `@assignee/core`
 * via the `cfn-keys/defaults.ts` module; we re-export the same symbol
 * for source-compatibility.
 */
export {
  AWS_REGION,
  CredentialError,
  AWS_SERVICE_EXECUTE_API,
} from "@assignee/core";
