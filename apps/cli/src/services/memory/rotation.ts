/**
 * Rotation helper for MemoryService record files.
 *
 * Extracted from memory.ts (Wave 6d F5). Preserves REG-N5 invariant:
 * lock acquired BEFORE read so concurrent appends cannot be clobbered.
 */
import type { FileStore } from "./file-store.js";

export type RotationPreserveFilter<T> = (record: T) => boolean;

interface RotateOptions<T> {
  store: FileStore;
  target: string;
  read: () => Promise<T[]>;
  maxRecords: number;
  label: string;
  preserveFilter?: RotationPreserveFilter<T>;
  /** When a preserveFilter is provided, records are re-sorted by this key. */
  sortByTimestamp?: (record: T) => number;
  suffix?: string;
}

/**
 * Generic rotation: trim oldest records to stay within maxRecords.
 *
 * When `preserveFilter` is provided, records matching it are never removed
 * even if they exceed maxRecords — only older non-preserved records are
 * trimmed.
 */
export async function rotateRecords<T>(
  opts: RotateOptions<T>,
): Promise<number> {
  const { store, target, read, maxRecords, label, preserveFilter } = opts;
  await store._ensureDirInternal();
  // Acquire lock BEFORE reading so a concurrent append can't slip a record
  // between read and write and have it clobbered. (REG-N5)
  const acquired = await store._acquireLockInternal(target);
  if (!acquired) {
    process.stderr.write(
      `WARNING: Could not acquire lock for ${label} — skipping rotation to prevent corruption.\n`,
    );
    return 0;
  }
  try {
    const existing = await read();
    if (existing.length <= maxRecords) return 0;

    let trimmed: T[];
    if (preserveFilter && opts.sortByTimestamp) {
      const preserved: T[] = [];
      const candidates: T[] = [];
      for (const record of existing) {
        if (preserveFilter(record)) {
          preserved.push(record);
        } else {
          candidates.push(record);
        }
      }
      const budget = Math.max(0, maxRecords - preserved.length);
      const keptCandidates = candidates.slice(-budget);
      const sortFn = opts.sortByTimestamp;
      trimmed = [...keptCandidates, ...preserved].sort(
        (a, b) => sortFn(a) - sortFn(b),
      );
    } else {
      trimmed = existing.slice(-maxRecords);
    }

    const removed = existing.length - trimmed.length;
    if (removed === 0) return 0;

    await store._atomicWriteInternal(target, JSON.stringify(trimmed, null, 2));
    return removed;
  } finally {
    await store._releaseLockInternal(target);
  }
}
