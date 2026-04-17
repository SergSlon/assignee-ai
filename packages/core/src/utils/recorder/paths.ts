/**
 * Filename sanitization + recording-directory resolution.
 *
 * Lifted from `apps/cli/src/utils/recorder/paths.ts` in Story 50-4
 * Wave 5 Pass A.
 */
import * as path from "node:path";

/** Maximum length per filename segment to keep paths bounded. */
const MAX_FILENAME_SEGMENT_LENGTH = 64;

/**
 * Sanitize a single filename segment by stripping path separators, dots, and
 * any other characters that could escape the parent directory or break the
 * filesystem. Empty results fall back to "unknown".
 */
export function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment
    .replace(/[/\\.]/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, MAX_FILENAME_SEGMENT_LENGTH);
  return cleaned.length > 0 ? cleaned : "unknown";
}

const RECORDINGS_BASE = path.resolve(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "test-fixtures",
  "recordings",
);

/** Returns the recording directory path for a given runId. */
export function getRecordingDir(runId: string): string {
  return path.join(RECORDINGS_BASE, runId);
}
