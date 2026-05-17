/**
 * Command name constants — assignee.ai CLI subcommands.
 *
 * Lifted into @assignee/core in Story 50-4 Wave 5 Pass C-2 so error-messages
 * catalogs and advice strings can reference command names without the CLI
 * reaching back into its own constants tree.
 *
 * Story 108-A-05: CLI restructured under noun groups (infra / admin / dev).
 * `CommandName` retains leaf-level names for use in `new Command(CommandName.X)`
 * Commander registrations (the leaf name is still the single word, e.g. "plan").
 * `CommandGroup` holds the noun-group names.
 * `CommandPath` holds full rooted paths (noun-group + leaf) for display and docs.
 */

/** Noun-group parent command names (v1.0 API freeze). */
export const CommandGroup = {
  INFRA: "infra",
  ADMIN: "admin",
  DEV: "dev",
} as const;

export type CommandGroupType = (typeof CommandGroup)[keyof typeof CommandGroup];

/**
 * Leaf command names — used as the first argument to `new Command(...)`.
 * These are single-word identifiers; they are always nested under a
 * `CommandGroup` parent in the Commander tree.
 */
export const CommandName = {
  // infra group
  APPLY: "apply",
  DESTROY: "destroy",
  DRIFT: "drift",
  OPTIMIZE: "optimize",
  PLAN: "plan",
  RECONCILE: "reconcile",
  RESTORE_PROVISIONS: "restore-provisions",
  // admin group
  AUDIT_VERIFY: "audit-verify",
  DESCRIBE: "describe",
  DOCTOR: "doctor",
  LIST: "list",
  STATUS: "status",
  // dev group
  COMPLETIONS: "completions",
  DISCOVER: "discover",
  INIT: "init",
  SETUP: "setup",
  UPDATE: "update",
  VERSION: "version",
} as const;

export type CommandNameType = (typeof CommandName)[keyof typeof CommandName];

/**
 * Full rooted paths for display, docs, and error messages.
 * Format: "<group> <leaf>", e.g. "infra plan".
 */
export const CommandPath = {
  // infra
  INFRA_APPLY: "infra apply",
  INFRA_DESTROY: "infra destroy",
  INFRA_DRIFT: "infra drift",
  INFRA_OPTIMIZE: "infra optimize",
  INFRA_PLAN: "infra plan",
  INFRA_RECONCILE: "infra reconcile",
  INFRA_RESTORE_PROVISIONS: "infra restore-provisions",
  // admin
  ADMIN_AUDIT_VERIFY: "admin audit-verify",
  ADMIN_DESCRIBE: "admin describe",
  ADMIN_DOCTOR: "admin doctor",
  ADMIN_LIST: "admin list",
  ADMIN_STATUS: "admin status",
  // dev
  DEV_COMPLETIONS: "dev completions",
  DEV_DISCOVER: "dev discover",
  DEV_INIT: "dev init",
  DEV_SETUP: "dev setup",
  DEV_UPDATE: "dev update",
  DEV_VERSION: "dev version",
} as const;

export type CommandPathType = (typeof CommandPath)[keyof typeof CommandPath];

export const CommandDescription = {
  // noun groups
  INFRA: "Manage cloud infrastructure (plan, apply, destroy, drift, …)",
  ADMIN: "Inspect and verify managed resources (status, list, doctor, …)",
  DEV: "Developer tooling (init, setup, completions, discover, …)",
  // leaf commands
  APPLY: "Execute an approved infrastructure plan",
  COMPLETIONS: "Output shell completion script",
  DESCRIBE:
    "Re-render the apply-success line for a previously-applied resource by run id or ARN",
  DESTROY: "Safely destroy a managed AWS resource",
  DISCOVER: "Interactively explore supported resource types and patterns",
  DOCTOR:
    "Run a non-destructive health check of credentials, Bedrock, MCP servers, cache, config and best-practices",
  DRIFT: "Check managed resources for configuration drift",
  INIT: "Initialize assignee.ai project configuration",
  LIST: "List all resources managed by assignee.ai",
  OPTIMIZE:
    "Analyse managed resources and emit cost/compliance recommendations",
  PLAN: "Generate an infrastructure plan from natural language intent",
  RECONCILE: "Reconcile drifted resources back to desired state",
  RESTORE_PROVISIONS:
    "Re-import provision records from CloudControl API into the local store",
  SETUP:
    "Create IAM users and policies for least-privilege credential separation",
  STATUS: "Show summary of managed infrastructure",
  UPDATE:
    "Refresh a deployed static-website: upload new files to S3 and invalidate CloudFront",
  VERSION: "Show CLI version and runtime information",
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
