/**
 * Shared EC2Client factory used by both apps/cli and apps/mcp-server.
 *
 * Centralizes construction so every caller gets the same region +
 * credential handling, and any future policy change (user-agent tag,
 * custom retry strategy, endpoint override) lives in one place.
 *
 * The returned client is a standard `@aws-sdk/client-ec2` instance —
 * callers invoke `.destroy()` themselves in their dispose paths
 * (mandatory in the long-running MCP server, best-effort in the
 * short-lived CLI).
 *
 * @see Story 49.3 — AWS SDK client lifecycle + EC2 factory
 */

import { EC2Client, type EC2ClientConfig } from "@aws-sdk/client-ec2";

/**
 * Construct an EC2 SDK client. Thin wrapper around `new EC2Client(...)`
 * — the central-constructor value here is a single grep anchor
 * (`createEC2Client`) that satisfies the audit constraint that
 * `new EC2Client(...)` may only appear in this file.
 */
export function createEC2Client(config: EC2ClientConfig): EC2Client {
  return new EC2Client(config);
}

// Re-export the client type so callers can keep typing their locals
// without re-importing from `@aws-sdk/client-ec2`.
export type { EC2Client, EC2ClientConfig };
