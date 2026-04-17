/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph/nodes/status-poller` (Story 50-4 Wave 5 Pass D).
 *
 * Preserves `feedback_cloudcontrol_notfound_short_circuit` — the CCAPI
 * NotFound short-circuit (treated as destroy success) is unchanged; only
 * the module location moved.
 */
export {
  statusPollerNode,
  isRetryableCloudFrontS3Error,
} from "@assignee/core/graph/nodes/status-poller.js";
