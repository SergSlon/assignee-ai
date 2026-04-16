/**
 * Credential bootstrap for the destroy_resource MCP tool.
 *
 * Resolves ASSIGNEE_OPERATOR_* credentials lazily and constructs the
 * ResourceGroupsTaggingAPIClient in the target region. Extracted from
 * the tool entrypoint to keep it under the 300 LOC budget.
 *
 * @see feedback_lazy_credential_resolution_in_mcp — per-server try/catch
 */

import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import { buildErrorResponse, type McpToolResponse } from "./error-envelope.js";

export interface CredentialBootstrapResult {
  operatorCreds: ExplicitAwsCredentials;
  taggingClient: ResourceGroupsTaggingAPIClient;
}

/**
 * Bootstrap operator credentials and a RGTA client.
 *
 * Returns either the credentials + client, or a pre-formatted MCP error
 * response that the caller can return directly.
 */
export function bootstrapOperatorCredentials(
  region: string,
):
  | { ok: true; result: CredentialBootstrapResult }
  | { ok: false; error: McpToolResponse } {
  // ── Lazy operator credential resolution (P0-1) ───────────────────
  // Never fall through to the host's default credential chain. Both
  // AWS clients are constructed with explicit ASSIGNEE_OPERATOR_*
  // credentials. If they're missing we fail fast with an actionable
  // hint instead of silently deleting resources under the MCP host's
  // profile.
  let operatorCreds: ExplicitAwsCredentials;
  try {
    operatorCreds = requireAssigneeCredentials("operator");
  } catch (err) {
    const message =
      err instanceof MissingAssigneeCredentialsError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      ok: false,
      error: buildErrorResponse(
        `Operator credentials are required to destroy resources: ${message}`,
        "Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY in the MCP server environment, or run 'assignee setup' to create the IAM users.",
      ),
    };
  }

  let taggingClient: ResourceGroupsTaggingAPIClient;
  try {
    taggingClient = new ResourceGroupsTaggingAPIClient({
      region,
      credentials: operatorCreds,
    });
  } catch (err) {
    return {
      ok: false,
      error: buildErrorResponse(
        `Failed to initialize AWS client: ${err instanceof Error ? err.message : String(err)}`,
        "Check that ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY are set.",
      ),
    };
  }

  return { ok: true, result: { operatorCreds, taggingClient } };
}
