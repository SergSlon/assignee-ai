/**
 * MCP Server configurations for the Assignee.ai CLI.
 * These configs are used by @langchain/mcp-adapters to spawn MCP server processes.
 *
 * Credential separation (3-user model — Story 18.8):
 *   - Operator (ASSIGNEE_OPERATOR_*): used directly by CLI for Bedrock + CloudControl
 *   - Reader (ASSIGNEE_READER_*): passed to MCP servers needing schema/pricing/billing
 *   - Auditor (ASSIGNEE_AUDITOR_*): passed to MCP servers needing IAM/SecurityHub access
 *   All sets live in .env — see .env.example.
 *
 * IMPORTANT: getMcpServerConfigs() is a factory function (not a const) so that
 * process.env is read at call time, after process.loadEnvFile() has run in index.ts.
 * ESM static imports execute before the module body, so a top-level const would
 * capture empty env vars on startup.
 *
 * SECURITY — subprocess credential isolation:
 *   readerEnv()/auditorEnv() call requireAssigneeCredentials() which THROWS
 *   MissingAssigneeCredentialsError if the role's env vars are unset. We never
 *   pass empty-string AWS_ACCESS_KEY_ID to an MCP subprocess — boto3 would fall
 *   through to ~/.aws/credentials / SSO / IMDS and defeat the 3-role model.
 *
 * SECURITY — supply-chain pinning:
 *   Every MCP server package below is pinned to an exact version string. NEVER
 *   use `@latest`: it opens the door to silent upstream compromise on every CLI
 *   invocation. Bump these deliberately after reviewing upstream release notes.
 *
 *   The remote `knowledge-mcp.global.api.aws` server executes code fetched over
 *   the network at runtime. It is gated behind ASSIGNEE_ENABLE_REMOTE_MCP=1 and
 *   is OFF by default. Users must explicitly opt in.
 *
 * @see architecture.md — MCP Servers Catalog section
 */
import { McpServerName, McpCommand } from "../constants/mcp.js";
import {
  DEFAULT_AWS_REGION,
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "@assignee/core";
import { AWS_REGION } from "./constants.js";

// ── Pinned MCP server versions ──────────────────────────────────────────────
// Bump deliberately after reviewing upstream release notes. Never use @latest.
const MCP_PINS = {
  AWS_PRICING: "awslabs.aws-pricing-mcp-server@1.0.6",
  AWS_DOCUMENTATION: "awslabs.aws-documentation-mcp-server@1.1.1",
  AWS_IAM: "awslabs.iam-mcp-server@1.0.2",
  AWS_WA_SECURITY: "awslabs.well-architected-security-mcp-server@1.0.2",
  AWS_COST_MANAGEMENT: "awslabs.cost-management-mcp-server@1.0.2",
} as const;

/** Env var that must be set to `1` to enable the remote knowledge MCP server. */
const ENABLE_REMOTE_MCP_VAR = "ASSIGNEE_ENABLE_REMOTE_MCP";

export interface McpServerConfig {
  /** The command to execute (e.g. 'uvx', 'npx') */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Optional environment variables for the server process */
  env?: Record<string, string>;
}

/**
 * Reader credential env block — maps ASSIGNEE_READER_* to standard AWS_* for MCP subprocess.
 * Used by: aws-pricing-mcp-server, aws-cost-management-mcp-server.
 *
 * Throws MissingAssigneeCredentialsError if ASSIGNEE_READER_* are unset.
 * Never emits empty-string credentials (which would cause boto3 to fall through
 * to ~/.aws/credentials / SSO / IMDS in the subprocess).
 */
function readerEnv(region = AWS_REGION): Record<string, string> {
  const creds = requireAssigneeCredentials("reader");
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Auditor credential env block — maps ASSIGNEE_AUDITOR_* to standard AWS_* for MCP subprocess.
 * Used by: iam-mcp-server, well-architected-security-mcp-server.
 *
 * Throws MissingAssigneeCredentialsError if ASSIGNEE_AUDITOR_* are unset.
 * Never emits empty-string credentials.
 */
function auditorEnv(region = AWS_REGION): Record<string, string> {
  const creds = requireAssigneeCredentials("auditor");
  return {
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
    AWS_DEFAULT_REGION: region,
    FASTMCP_LOG_LEVEL: "ERROR",
  };
}

/**
 * Factory that returns the 2 core MCP server process configurations.
 * Called at runtime (not module load) so credential env vars are available.
 *
 * Region notes:
 *   - Pricing: us-east-1 — AWS Pricing API only available in us-east-1
 *   - Docs:    no AWS creds — public documentation API via uvx subprocess
 *
 * Note: Schema fetching is handled
 * by CloudFormationSchemaService (direct SDK) — see Story 31.3.
 */
export function getMcpServerConfigs(): Record<string, McpServerConfig> {
  return {
    // Pricing API is only available in us-east-1
    // --with "botocore[crt]" is required for the pricing server's AWS credential chain
    [McpServerName.PRICING]: {
      command: McpCommand.UVX,
      args: ["--with", "botocore[crt]", MCP_PINS.AWS_PRICING],
      env: readerEnv(DEFAULT_AWS_REGION),
    },
    // Documentation server: targeted section-level access to AWS official docs via read_sections.
    // Complements the Knowledge server (which adds blogs/What's New/Builder Center/regional data).
    // No AWS credentials needed — public documentation API.
    [McpServerName.DOCS]: {
      command: McpCommand.UVX,
      args: [MCP_PINS.AWS_DOCUMENTATION],
    },
  };
}

/**
 * Factory that returns MCP server configs for optional intelligence servers.
 * These servers are non-critical — if they fail to start, provisioning continues without them.
 * Spawned as a separate MultiServerMCPClient instance so failures don't crash core servers.
 *
 * @see Story 19.1 — IAM MCP server (read-only)
 * @see Story 19.2 — Well-Architected Security MCP server
 */
export function getOptionalMcpServerConfigs(): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};

  // Knowledge server: REMOTE API — executes code fetched over the network.
  // OFF by default; opt-in via ASSIGNEE_ENABLE_REMOTE_MCP=1.
  if (process.env[ENABLE_REMOTE_MCP_VAR] === "1") {
    configs[McpServerName.KNOWLEDGE] = {
      command: McpCommand.UVX,
      args: ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"],
    };
  }

  // Auditor-scoped servers: skip gracefully if ASSIGNEE_AUDITOR_* unset.
  // These are optional by design — missing credentials must NOT crash the
  // CLI, and we must NEVER launch them with empty-string creds (which would
  // fall through to ~/.aws/credentials in the subprocess).
  try {
    const auditor = auditorEnv();
    configs[McpServerName.IAM] = {
      command: McpCommand.UVX,
      args: [MCP_PINS.AWS_IAM, "--readonly"],
      env: auditor,
    };
    // Well-Architected Security: post-provision security posture analysis.
    // Aggregates findings from SecurityHub, GuardDuty, Inspector, IAM Access Analyzer.
    configs[McpServerName.WELL_ARCHITECTED_SECURITY] = {
      command: McpCommand.UVX,
      args: [MCP_PINS.AWS_WA_SECURITY],
      env: auditor,
    };
  } catch (err) {
    if (!(err instanceof MissingAssigneeCredentialsError)) throw err;
    // Silently omit auditor-scoped servers when creds are not configured.
  }

  // Reader-scoped billing server: live billing data for cost estimates and
  // savings display. Requires ce:GetCostAndUsage + ce:GetCostForecast.
  try {
    configs[McpServerName.BILLING] = {
      command: McpCommand.UVX,
      args: [MCP_PINS.AWS_COST_MANAGEMENT],
      env: readerEnv(),
    };
  } catch (err) {
    if (!(err instanceof MissingAssigneeCredentialsError)) throw err;
    // Silently omit billing server when reader creds are not configured.
  }

  return configs;
}
