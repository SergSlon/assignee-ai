export const CommandName = {
  APPLY: "apply",
  COMPLETIONS: "completions",
  INIT: "init",
  PLAN: "plan",
} as const;

export type CommandNameType = (typeof CommandName)[keyof typeof CommandName];

export const CommandDescription = {
  APPLY: "Execute an approved infrastructure plan",
  COMPLETIONS: "Output shell completion script",
  INIT: "Initialize assignee.ai project configuration",
  PLAN: "Generate an infrastructure plan from natural language intent",
} as const;

export const CommandArgs = {
  INTENT: {
    NAME: "[intent]",
    DESC: "Natural language description of desired infrastructure",
  },
} as const;

export const CommandOptions = {
  DRY_RUN: {
    FLAGS: "--dry-run",
    DESC: "Show what would be done without executing",
  },
} as const;
