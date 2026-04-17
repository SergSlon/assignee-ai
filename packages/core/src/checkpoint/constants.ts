/**
 * Checkpoint module constants — lifted into @assignee/core by Story 50-4
 * so both apps/cli and apps/mcp-server share identical filename / TTL /
 * cleanup-window values.
 *
 * If you change any of these, update the references in both apps'
 * constants files too (they re-export from here for discoverability).
 */

/** Prefix for checkpoint filenames under `.assignee/checkpoints/`. */
export const CHECKPOINT_FILE_PREFIX = "checkpoint-" as const;

/** Default TTL (hours) after which a checkpoint is considered expired. */
export const CHECKPOINT_DEFAULT_TTL_HOURS = 72;

/**
 * The pruner skips files modified within this window so a concurrent
 * writer isn't stomped. Matches the CLI's CLEANUP_SKIP_RECENT_MINUTES
 * exactly — consumers override via options when a shorter window is
 * warranted (tests, integration suites).
 */
export const CHECKPOINT_CLEANUP_SKIP_RECENT_MINUTES = 10;
