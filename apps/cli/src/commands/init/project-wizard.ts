/**
 * Project init wizard — prompts for region/profile/environment/auto-fix.
 *
 * Preserves Wave-2 P1-4 3-mode (ask/apply/skip) persisting to
 * `preferences.auto_fix`.
 */

import * as clack from "@clack/prompts";
import { DEFAULT_AWS_REGION, AssigneeTag, AutoFixMode } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import type { ProjectConfig } from "./project-config-types.js";

const ENVIRONMENT_OPTIONS = [
  { value: "development", label: "development" },
  { value: "staging", label: "staging" },
  { value: "production", label: "production" },
] as const;

/**
 * Prompts the user for project-config values. Returns undefined if the user
 * cancelled at any step.
 */
export async function promptProjectConfig(defaults: {
  region?: string | undefined;
  profile?: string | undefined;
}): Promise<ProjectConfig | undefined> {
  const region = await clack.text({
    message: "AWS Region",
    initialValue: defaults.region ?? DEFAULT_AWS_REGION,
  });

  if (clack.isCancel(region)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  const profile = await clack.text({
    message: "AWS Profile",
    initialValue: defaults.profile ?? "default",
  });

  if (clack.isCancel(profile)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  const environment = await clack.select({
    message: "Environment",
    options: [...ENVIRONMENT_OPTIONS],
  });

  if (clack.isCancel(environment)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // P1-4 (Wave-2 F6, 2026-04-14): 3-way select, NOT boolean. User MUST be
  // able to pick `skip`. See feedback_autofix_user_decides memory.
  const autoFix = await clack.select({
    message:
      "Auto-fix security best-practice violations? (encryption, IMDSv2, public access blocking, etc.)",
    options: [
      {
        value: AutoFixMode.ASK,
        label: "ask — prompt before each fix (default)",
      },
      { value: AutoFixMode.APPLY, label: "apply — fix automatically" },
      { value: AutoFixMode.SKIP, label: "skip — never auto-fix" },
    ],
    initialValue: AutoFixMode.ASK,
  });

  if (clack.isCancel(autoFix)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  const autoFixMode = autoFix as (typeof AutoFixMode)[keyof typeof AutoFixMode];

  return {
    region: region as string,
    profile: profile as string,
    tags: {
      [AssigneeTag.KEY]: AssigneeTag.VALUE,
      environment: environment as string,
    },
    // Retain the legacy boolean shape for back-compat: `apply` → true,
    // `ask`/`skip` → false. Authoritative value lives in preferences.auto_fix.
    autoFixBestPractices: autoFixMode === AutoFixMode.APPLY,
    defaults: {
      region: region as string,
      tags: {
        [AssigneeTag.KEY]: AssigneeTag.VALUE,
        environment: environment as string,
      },
    },
    preferences: {
      auto_fix: autoFixMode,
    },
  };
}
