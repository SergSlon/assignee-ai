/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/utils/fix-command-resolver` (Story 50-4 Wave 5 Pass C-2).
 */
export {
  FixCategory,
  type FixCategoryType,
  type FindingAction,
  resolveAction,
  countFixable,
  countAutoFixable,
} from "@assignee/core";
