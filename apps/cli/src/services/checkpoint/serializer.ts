/**
 * @deprecated Import `serializeCheckpoint` from `@assignee/core/checkpoint`.
 * Thin re-export preserved during Story 50-4. CLI's `AgentState` is
 * structurally compatible with core's `SerializableGraphState`, so no
 * shim adapter is needed — pass AgentState directly.
 */
export { serializeCheckpoint } from "@assignee/core/checkpoint";
