/**
 * Size limits, memory caps, pricing calc constants. Domain sub-module
 * of the former `config/constants.ts` coupling hub (Story 49.5).
 */

/** Maximum characters of the CFN schema excerpt passed to the plan generator prompt. */
export const SCHEMA_EXCERPT_MAX_CHARS = 3000;

/** Default TTL for plan checkpoints in hours. */
export const CHECKPOINT_DEFAULT_TTL_HOURS = 72;

/** Maximum number of provision records to keep in memory rotation. */
export const MEMORY_MAX_PROVISIONS = 200;

/** Maximum number of failure records to keep in memory rotation. */
export const MEMORY_MAX_FAILURES = 100;

/** Maximum number of pattern records to keep in memory rotation. */
export const MEMORY_MAX_PATTERNS = 100;

/** Average hours per month for pricing calculations (365 * 24 / 12). */
export const HOURS_PER_MONTH = 730;
