import { CloudControlClient } from "@aws-sdk/client-cloudcontrol";

let _client: CloudControlClient | null = null;

/**
 * Returns a singleton CloudControlClient configured with MCP_AWS_* credentials.
 *
 * Uses MCP_AWS_* env vars (aws-mcp-user) — not AWS_* (bedrock-dev-user).
 * The IAM permissions for cloudcontrol:* are on aws-mcp-user via AssigneeAiMcpPolicy.
 *
 * @see mcp-servers.ts — mcpEnv() for the same credential separation pattern
 */
export function getCloudControlClient(): CloudControlClient {
  if (!_client) {
    _client = new CloudControlClient({
      region: process.env["AWS_REGION"] ?? "us-east-1",
      credentials: {
        accessKeyId: process.env["MCP_AWS_ACCESS_KEY_ID"] ?? "",
        secretAccessKey: process.env["MCP_AWS_SECRET_ACCESS_KEY"] ?? "",
      },
    });
  }
  return _client;
}
