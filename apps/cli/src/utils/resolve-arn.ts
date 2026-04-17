/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/utils/resolve-arn` (Story 50-4 Wave 5 Pass C-2).
 */
export {
  getOperatorAccountId,
  getOperatorCallerArn,
  resetAccountIdCache,
  resolveResourceArn,
} from "@assignee/core";
