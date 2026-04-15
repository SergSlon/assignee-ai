/**
 * Dry-run counter for memory rotation.
 *
 * Reads the current provisions/failures/patterns sizes and reports the
 * over-cap counts that `runFullCleanup` would trim. Read-only mirror of
 * MemoryService.rotate*.
 *
 * @see Story 33.2
 */

import type { MemoryService } from "../memory.js";

/**
 * For dry-run mode: count how many memory records would be trimmed per file.
 */
export async function dryRunMemory(
  memoryService: MemoryService,
): Promise<{ provisions: number; failures: number; patterns: number }> {
  const provisions = await memoryService.readProvisions();
  const failures = await memoryService.readFailures();
  const patterns = await memoryService.readPatterns();

  // Import constants to determine caps
  const { MEMORY_MAX_PROVISIONS, MEMORY_MAX_FAILURES, MEMORY_MAX_PATTERNS } =
    await import("../../config/constants.js");

  return {
    provisions: Math.max(0, provisions.length - MEMORY_MAX_PROVISIONS),
    failures: Math.max(0, failures.length - MEMORY_MAX_FAILURES),
    patterns: Math.max(0, patterns.length - MEMORY_MAX_PATTERNS),
  };
}
