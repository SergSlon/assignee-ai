/**
 * Recording interceptor — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core`
 * (lifted in Story 50-4 Wave 5 Pass A so the in-core LlmAdapter can
 * use RecordingLlmAdapter without reaching back into the CLI app).
 *
 * Activation is unchanged: `ASSIGNEE_RECORD=1` — when disabled (default),
 * zero overhead; no wrapping, no file I/O.
 */
export type {
  McpRecordedCall,
  SdkRecordedCall,
  LlmRecordedCall,
  RecordedCall,
  RecordingManifest,
} from "@assignee/core";
export {
  redactStringValue,
  sanitizeFilenameSegment,
  getRecordingDir,
  RecordingInterceptor,
  isRecordingEnabled,
  wrapToolWithRecorder,
  addRecordingMiddleware,
  RecordingLlmAdapter,
} from "@assignee/core";
