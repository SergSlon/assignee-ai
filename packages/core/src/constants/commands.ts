/**
 * Command name constants — assignee.ai CLI subcommands.
 *
 * Lifted into @assignee/core in Story 50-4 Wave 5 Pass C-2 so error-messages
 * catalogs and advice strings can reference command names without the CLI
 * reaching back into its own constants tree.
 */

export const CommandName = {
  APPLY: "apply",
  COMPLETIONS: "completions",
  DESCRIBE: "describe",
  DESTROY: "destroy",
  DOCTOR: "doctor",
  DRIFT: "drift",
  INIT: "init",
  LIST: "list",
  PLAN: "plan",
  RECONCILE: "reconcile",
  SETUP: "setup",
  STATUS: "status",
} as const;

export type CommandNameType = (typeof CommandName)[keyof typeof CommandName];

export const CommandDescription = {
  APPLY: "Execute an approved infrastructure plan",
  COMPLETIONS: "Output shell completion script",
  DESCRIBE:
    "Re-render the apply-success line for a previously-applied resource by run id or ARN",
  DESTROY: "Safely destroy a managed AWS resource",
  DOCTOR:
    "Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices",
  DRIFT: "Check managed resources for configuration drift",
  INIT: "Initialize assignee.ai project configuration",
  LIST: "List all resources managed by assignee.ai",
  PLAN: "Generate an infrastructure plan from natural language intent",
  RECONCILE: "Reconcile drifted resources back to desired state",
  SETUP:
    "Create IAM users and policies for least-privilege credential separation",
  STATUS: "Show summary of managed infrastructure",
} as const;

export const CommandArgs = {
  INTENT: {
    NAME: "[intent]",
    DESC: "Natural language description of desired infrastructure",
  },
  RESOURCE: {
    NAME: "<resource>",
    DESC: "Resource ARN or name to destroy",
  },
} as const;

export const CommandOptions = {
  DRY_RUN: {
    FLAGS: "--dry-run",
    DESC: "Show what would be done without executing",
  },
} as const;
