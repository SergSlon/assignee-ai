/**
 * Shape of the `.assignee/config.yaml` project config file.
 * Must be compatible with the user-config-loader.ts schema (Story 7.2).
 */

import { AutoFixMode } from "@assignee/core";

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
    auto_fix?: (typeof AutoFixMode)[keyof typeof AutoFixMode];
  };
  priceCacheTtlMinutes?: number;
}
