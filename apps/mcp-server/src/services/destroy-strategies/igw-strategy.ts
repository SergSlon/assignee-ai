/**
 * @deprecated Import `ec2InternetGatewayStrategy` from `@assignee/core`.
 * Thin re-export preserved during Story 50-4 so existing MCP test
 * imports (`../igw-strategy.js`) continue to resolve.
 *
 * Legacy alias `igwStrategy` preserved for test imports.
 */
export {
  ec2InternetGatewayStrategy,
  ec2InternetGatewayStrategy as igwStrategy,
} from "@assignee/core";
