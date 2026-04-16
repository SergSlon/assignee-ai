/**
 * Shared list-resources types — the canonical shape for resources
 * returned by `assignee list` and the `list_managed_resources` MCP
 * tool, plus the provision-log entry shape both apps read from
 * `~/.assignee/memory/provisions.json`.
 *
 * Extracted into `@assignee/core` by Story 49.2 (Epic 49) to
 * consolidate the prior duplicated copies across apps/cli and
 * apps/mcp-server.
 */

/** Shape of a managed resource returned by the list service. */
export interface ManagedResource {
  resourceType: string;
  arn: string;
  region: string;
  createdDate: string;
  estimatedMonthlyCost: string;
}

/** Provision log entry from `~/.assignee/memory/provisions.json`. */
export interface ProvisionLogEntry {
  runId?: string;
  resourceType?: string;
  resourceArn?: string;
  region?: string;
  estimatedMonthlyCost?: string;
  timestamp?: string;
}
