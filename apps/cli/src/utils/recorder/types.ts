/**
 * Recorded-call shapes + manifest type.
 * Extracted from recorder.ts (Wave 6d F5).
 */

export interface McpRecordedCall {
  type: "mcp";
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface SdkRecordedCall {
  type: "sdk";
  service: string;
  operation: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface LlmRecordedCall {
  type: "llm";
  method: string;
  prompt: string;
  response?: unknown;
  error?: string;
  model: string;
  durationMs: number;
  timestamp: string;
}

export type RecordedCall = McpRecordedCall | SdkRecordedCall | LlmRecordedCall;

export interface RecordingManifest {
  runId: string;
  command: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  files: string[];
}
