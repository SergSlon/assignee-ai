/**
 * Recording interceptor for capturing external API calls to JSON fixtures.
 * Activated via `ASSIGNEE_RECORD=1` environment variable. When disabled
 * (default), zero overhead — no wrapping, no file I/O.
 *
 * Lifted from `apps/cli/src/utils/recorder.ts` in Story 50-4 Wave 5
 * Pass A.
 *
 * Decomposed across ./*:
 *   - types.ts          — RecordedCall union + RecordingManifest
 *   - redaction.ts      — allowlist-based sensitive-data scrubbing
 *                         (feedback_redaction_allowlist_not_denylist)
 *   - paths.ts          — filename sanitization + recording dir resolution
 *   - session.ts        — RecordingInterceptor + isRecordingEnabled
 *   - mcp-wrapper.ts    — wrapToolWithRecorder for StructuredTool
 *   - sdk-middleware.ts — addRecordingMiddleware for AWS SDK v3
 *   - llm-recorder.ts   — RecordingLlmAdapter (LlmPort pass-through)
 */
export type {
  McpRecordedCall,
  SdkRecordedCall,
  LlmRecordedCall,
  RecordedCall,
  RecordingManifest,
} from "./types.js";
export { redactStringValue, redactSensitive } from "./redaction.js";
export { sanitizeFilenameSegment, getRecordingDir } from "./paths.js";
export { RecordingInterceptor, isRecordingEnabled } from "./session.js";
export { wrapToolWithRecorder } from "./mcp-wrapper.js";
export { addRecordingMiddleware } from "./sdk-middleware.js";
export { RecordingLlmAdapter } from "./llm-recorder.js";
