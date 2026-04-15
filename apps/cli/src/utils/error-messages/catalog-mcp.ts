/** MCP server error message catalog. */

import { ErrorCode } from "../../constants/errors.js";
import type { ErrorMessageEntry } from "./types.js";

export const MCP_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.MCP_STARTUP_FAILED]: {
    code: ErrorCode.MCP_STARTUP_FAILED,
    what: "An MCP server failed to start.",
    why: "One of the required MCP server processes could not be launched. It may not be installed or the binary path may be incorrect.",
    howToFix:
      "Ensure all MCP servers are installed. Run `npx` for the failing server to verify it is available. Check the error message above for the specific server name.",
  },
  [ErrorCode.MCP_TOOL_NOT_FOUND]: {
    code: ErrorCode.MCP_TOOL_NOT_FOUND,
    what: "A required MCP tool is not available.",
    why: "The MCP server is running but does not expose the expected tool. The server version may be incompatible.",
    howToFix:
      "Update your MCP server packages to the latest version and restart assignee.ai.",
  },
  [ErrorCode.CFN_MCP_UNAVAILABLE]: {
    code: ErrorCode.CFN_MCP_UNAVAILABLE,
    what: "The CloudFormation schema service is not available.",
    why: "The CloudFormation DescribeType SDK call failed. Schema fetching uses the AWS SDK directly to fetch resource type schemas for plan generation.",
    howToFix:
      "Verify your ASSIGNEE_OPERATOR credentials have cloudformation:DescribeType permission and check network connectivity.",
  },
};
