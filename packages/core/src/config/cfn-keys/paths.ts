/**
 * File/directory path constants — single source of truth for Assignee's
 * on-disk layout. Split out of `cfn-keys.ts` for SRP.
 */

/** The `.assignee` directory name — single source of truth for project/home config paths. */
export const ASSIGNEE_DIR = ".assignee";

/** Cache subdirectory name under ASSIGNEE_DIR — single source of truth. */
export const CACHE_DIR_NAME = "cache";
