/**
 * Shape of the `.assignee/config.yaml` project config file.
 * Must be compatible with the user-config-loader.ts schema (Story 7.2).
 *
 * Also defines the `NonInteractiveOverrides` bag carried from the
 * Commander entry point through the project/global flow and into the
 * wizard (Epic 92 u.d / D-06). Lives in this types module — not
 * project-flow — to avoid a circular import between project-flow and
 * project-wizard.
 */

import type { AutoFixModeType } from "@assignee/core";

export interface ProjectConfig {
  region: string;
  profile: string;
  tags: {
    [key: string]: string;
    environment: string;
  };
  autoFixBestPractices?: boolean;
  /** Nested AssigneeConfig shape consumed by project-config-loader */
  defaults?: { region?: string; tags?: Record<string, string> };
  preferences?: {
    /** One of AutoFixMode: "ask" | "apply" | "skip". */
    auto_fix?: AutoFixModeType;
  };
  priceCacheTtlMinutes?: number;
}

/**
 * Flag-driven overrides that, when present, skip the matching prompt and
 * short-circuit overwrite confirmation.
 */
export interface NonInteractiveOverrides {
  /** `--yes` was passed — accept defaults, skip overwrite confirmation. */
  yes?: boolean;
  /** `--region <r>` — pin the region, skip the region prompt. */
  region?: string | undefined;
  /** `--auto-fix <mode>` — pin the mode, skip the auto-fix prompt. */
  autoFix?: AutoFixModeType | undefined;
}
