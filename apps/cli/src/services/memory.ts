/**
 * MemoryService — JSON-file backed memory for provisions, failures, and patterns.
 *
 * Wave 6d F5: barrel after decomposition into ./memory/*:
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
export { MemoryService } from "./memory/service.js";
import { MemoryService } from "./memory/service.js";

/** Default singleton instance for production use. Tests can instantiate with a temp dir. */
export const defaultMemoryService = new MemoryService();
