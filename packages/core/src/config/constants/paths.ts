/**
 * Filesystem path + filename constants. Domain sub-module of the
 * former `config/constants.ts` coupling hub (Story 49.5).
 */

import { ASSIGNEE_DIR } from "../cfn-keys.js";

export { ASSIGNEE_DIR };

/** Directory for checkpoint files, relative to project root. */
export const CHECKPOINT_DIR = ASSIGNEE_DIR;

/**
 * Directory for baseline files written by `assignee drift --baseline <arn>`.
 * Lives under `.assignee/baselines/` so it shares project scoping with
 * checkpoints but never conflicts with the `checkpoint-*.json` file names
 * `resolveDesiredState()` scans.
 */
export const BASELINES_DIR = `${ASSIGNEE_DIR}/baselines` as const;

/** Named file constants — single source of truth for file names. */
export const FileName = {
  PROVISIONS: "provisions.json",
  FAILURES: "failures.json",
  PATTERNS: "patterns.json",
  DESTROYED_ARNS: "destroyed-arns.json",
  CONFIG: "config.yaml",
  ORG_POLICY: "org-policy.yaml",
} as const;

/** @deprecated Use FileName.PROVISIONS */
export const PROVISIONS_FILE = FileName.PROVISIONS;

/** @deprecated Use FileName.FAILURES */
export const FAILURES_FILE = FileName.FAILURES;

/** Prefix for checkpoint files: checkpoint-<runId>.json */
export const CHECKPOINT_FILE_PREFIX = "checkpoint-" as const;
