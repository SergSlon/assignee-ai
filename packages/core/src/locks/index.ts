/**
 * Core locks barrel — shared advisory-lock primitives consumed by both
 * `apps/cli` (e.g. Wave B-2 `restore-provisions --from-audit-log`) and
 * `apps/mcp-server` (provision write paths). Apps must NEVER reach into
 * `../locks/file-advisory-lock.js` directly so the implementation stays
 * private to core.
 *
 * Wave B-2 (epic-104-demo-dryrun) introduced this barrel: the audit-log
 * fallback append path needs to acquire `defaultFileAdvisoryLock` against
 * `PROVISIONS_LOCK_NAME` so concurrent applies do not interleave with the
 * recovery write. Before this barrel that lock had no public re-export.
 */

export {
  defaultFileAdvisoryLock,
  FileAdvisoryLockAdapter,
  LockAcquisitionError,
  FILE_LOCK_STALE_TIMEOUT_MS,
  FILE_LOCK_MAX_RETRIES,
  FILE_LOCK_RETRY_DELAY_MS,
} from "./file-advisory-lock.js";

export type { AdvisoryLockPort } from "../ports/advisory-lock-port.js";
