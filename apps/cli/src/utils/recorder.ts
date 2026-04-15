/**
 * Recording interceptor for capturing external API calls to JSON fixtures.
 * Activated via `ASSIGNEE_RECORD=1` environment variable. When disabled
 * (default), zero overhead — no wrapping, no file I/O.
 *
 * Wave 6d F5: barrel after decomposition into ./recorder/*:
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
} from "./recorder/types.js";
export { redactStringValue } from "./recorder/redaction.js";
export { sanitizeFilenameSegment, getRecordingDir } from "./recorder/paths.js";
export {
  RecordingInterceptor,
  isRecordingEnabled,
} from "./recorder/session.js";
export { wrapToolWithRecorder } from "./recorder/mcp-wrapper.js";
export { addRecordingMiddleware } from "./recorder/sdk-middleware.js";
export { RecordingLlmAdapter } from "./recorder/llm-recorder.js";
