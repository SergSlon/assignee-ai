/**
 * MemoryService — JSON-file backed memory for provisions, failures, and patterns.
 *
 * Story 50-4 Wave 5 Pass H: lifted from `apps/cli/src/services/memory.ts`
 * to core. The decomposed implementation lives in `./memory/*`:
 *   - file-store.ts  — fs primitives (ensureDir, atomicWrite, advisory locks,
 *                       corrupt-file backup)
 *   - rotation.ts    — generic trim helper used by rotateProvisions/Failures/Patterns
 *                       (preserves REG-N5: lock BEFORE read)
 *   - service.ts     — public MemoryService class (reads + append + upsert + rotate)
 *
 * Design rules:
 * - Reads return empty arrays on failure (graceful degradation).
 * - Writes are fire-and-forget — callers should catch and log, never throw.
 * - Constructor-injected directory for test isolation.
 */
export {
  MemoryService,
  _resetAlreadyWarnedFilesForTesting,
} from "./memory/service.js";
import { MemoryService } from "./memory/service.js";

/** Default singleton instance for production use. Tests can instantiate with a temp dir. */
export const defaultMemoryService = new MemoryService();
