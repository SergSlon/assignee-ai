export const CommandName = {
  APPLY: "apply",
  COMPLETIONS: "completions",
  DESTROY: "destroy",
  INIT: "init",
  LIST: "list",
  PLAN: "plan",
  STATUS: "status",
} as const;

export type CommandNameType = (typeof CommandName)[keyof typeof CommandName];

export const CommandDescription = {
  APPLY: "Execute an approved infrastructure plan",
  COMPLETIONS: "Output shell completion script",
  DESTROY: "Safely destroy a managed AWS resource",
  INIT: "Initialize assignee.ai project configuration",
  LIST: "List all resources managed by assignee.ai",
  PLAN: "Generate an infrastructure plan from natural language intent",
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
