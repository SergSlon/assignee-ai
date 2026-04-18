/**
 * Builds the CloudWatchLogs + Bedrock clients used by Tasks 3–4 of the
 * Bedrock invocation-logging setup. Centralises the dynamic imports so
 * the orchestrator body stays ≤ 30 LOC (story 54-it1-09).
 *
 * NOTE: AWS SDK v3 clients are cheap to construct and do not hold
 * open connections until the first `send()`, so building both here
 * even if one isn't needed is safe.
 */

import type { AdminClientConfig } from "../credentials.js";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import type { BedrockClient } from "@aws-sdk/client-bedrock";

/**
 * Construct the CWL + Bedrock clients for the current setup region.
 * Uses dynamic imports so the SDK modules are code-split and not
 * loaded unless the setup command actually runs.
 */
export async function buildBedrockLoggingClients(
  clientConfig: AdminClientConfig,
  region: string,
): Promise<{ cwl: CloudWatchLogsClient; bedrock: BedrockClient }> {
  const [{ CloudWatchLogsClient }, { BedrockClient }] = await Promise.all([
    import("@aws-sdk/client-cloudwatch-logs"),
    import("@aws-sdk/client-bedrock"),
  ]);
  const cwl = new CloudWatchLogsClient({ ...clientConfig, region });
  const bedrock = new BedrockClient({ ...clientConfig, region });
  return { cwl, bedrock };
}
