/**
 * Project init wizard — prompts for region/profile/environment/auto-fix.
 *
 * Preserves Wave-2 P1-4 3-mode (ask/apply/skip) persisting to
 * `preferences.auto_fix`.
 *
 * Epic 92 u.d: accepts a `NonInteractiveOverrides` bag so the wizard can
 * skip individual prompts when their flag equivalent is supplied. When
 * `overrides.yes` is set AND a value is not otherwise provided, the
 * wizard uses safe defaults instead of prompting. Interactive path
 * (no overrides) is unchanged.
 */

import * as clack from "@clack/prompts";
import { DEFAULT_AWS_REGION, AssigneeTag, AutoFixMode } from "@assignee/core";
import type { AutoFixModeType } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import type {
  ProjectConfig,
  NonInteractiveOverrides,
} from "./project-config-types.js";

const ENVIRONMENT_OPTIONS = [
  { value: "development", label: "development" },
  { value: "staging", label: "staging" },
  { value: "production", label: "production" },
] as const;

const DEFAULT_PROFILE = "default";
const DEFAULT_ENVIRONMENT = "development";

/**
 * Prompts the user for project-config values. Returns undefined if the user
 * cancelled at any step. When `overrides.yes` is true, prompts that don't
 * have a matching override flag fall back to safe defaults
 * (profile=default, environment=development).
 */
export async function promptProjectConfig(
  defaults: {
    region?: string | undefined;
    profile?: string | undefined;
  },
  overrides: NonInteractiveOverrides = {},
): Promise<ProjectConfig | undefined> {
  const skipPrompts = overrides.yes === true;

  // ── Region ───────────────────────────────────────────────────────────
  let regionValue: string;
  if (overrides.region !== undefined) {
    regionValue = overrides.region;
  } else if (skipPrompts) {
    regionValue = defaults.region ?? DEFAULT_AWS_REGION;
  } else {
    const region = await clack.text({
      message: "AWS Region",
      initialValue: defaults.region ?? DEFAULT_AWS_REGION,
    });

    if (clack.isCancel(region)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }
    regionValue = region as string;
  }

  // ── Profile ──────────────────────────────────────────────────────────
  let profileValue: string;
  if (skipPrompts) {
    profileValue = defaults.profile ?? DEFAULT_PROFILE;
  } else {
    const profile = await clack.text({
      message: "AWS Profile",
      placeholder:
        "Documentation only — not the auth source (creds come from env or ~/.aws/credentials).",
      initialValue: defaults.profile ?? DEFAULT_PROFILE,
    });

    if (clack.isCancel(profile)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }
    profileValue = profile as string;
  }

  // ── Environment ──────────────────────────────────────────────────────
  let environmentValue: string;
  if (skipPrompts) {
    environmentValue = DEFAULT_ENVIRONMENT;
  } else {
    const environment = await clack.select({
      message: "Environment",
      options: [...ENVIRONMENT_OPTIONS],
    });

    if (clack.isCancel(environment)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }
    environmentValue = environment as string;
  }

  // ── Auto-fix ─────────────────────────────────────────────────────────
  // P1-4 (Wave-2 F6, 2026-04-14): 3-way select, NOT boolean. User MUST be
  // able to pick `skip`. See feedback_autofix_user_decides memory.
  let autoFixMode: AutoFixModeType;
  if (overrides.autoFix !== undefined) {
    autoFixMode = overrides.autoFix;
  } else if (skipPrompts) {
    autoFixMode = AutoFixMode.ASK;
  } else {
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
    autoFixMode = autoFix as AutoFixModeType;
  }

  return {
    region: regionValue,
    profile: profileValue,
    tags: {
      [AssigneeTag.KEY]: AssigneeTag.VALUE,
      environment: environmentValue,
    },
    // Retain the legacy boolean shape for back-compat: `apply` → true,
    // `ask`/`skip` → false. Authoritative value lives in preferences.auto_fix.
    autoFixBestPractices: autoFixMode === AutoFixMode.APPLY,
    defaults: {
      region: regionValue,
      tags: {
        [AssigneeTag.KEY]: AssigneeTag.VALUE,
        environment: environmentValue,
      },
    },
    preferences: {
      auto_fix: autoFixMode,
    },
  };
}
