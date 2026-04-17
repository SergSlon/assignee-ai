/**
 * @deprecated Import `dynamodbTableStrategy` from `@assignee/core`.
 * Thin re-export preserved during Story 50-4 so existing MCP test
 * imports (`../dynamodb-strategy.js`) continue to resolve. The MCP
 * registry pulls the strategy from @assignee/core directly (see index.ts).
 *
 * Legacy alias `dynamodbStrategy` preserved for test imports.
 */
export {
  dynamodbTableStrategy,
  dynamodbTableStrategy as dynamodbStrategy,
} from "@assignee/core";
