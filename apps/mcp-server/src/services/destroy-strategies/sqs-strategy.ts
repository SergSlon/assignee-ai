/**
 * @deprecated Import `sqsQueueStrategy` from `@assignee/core`.
 * Thin re-export preserved during Story 50-4 so existing MCP test
 * imports (`../sqs-strategy.js`) continue to resolve.
 *
 * Legacy alias `sqsStrategy` preserved for test imports.
 */
export {
  sqsQueueStrategy,
  sqsQueueStrategy as sqsStrategy,
} from "@assignee/core";
