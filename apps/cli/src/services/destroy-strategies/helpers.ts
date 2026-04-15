/**
 * Shared helpers for CLI destroy strategies. Extracted from
 * destroy-service.ts during Wave-6 F1b so individual strategy files
 * can call them without importing from the dispatcher (which would
 * introduce a cycle).
 *
 * Helpers housed here:
 * - `warnDestroy` — structured stderr warn-level log.
 * - `classifyNotFoundShortCircuit` — Wave-11 P2-2 cross-account guard.
 * - `pollDeleteStatus` — generic CCAPI poll loop (uses the adapter).
 *
 * @see Wave-6 F1b
 */

import { extractAccountIdFromArn } from "@assignee/core";
import type { CloudControlAdapter } from "../cloudcontrol-adapter.js";
import {
  DESTROY_MAX_POLL_ATTEMPTS,
  DESTROY_POLL_INTERVAL_MS,
} from "../../config/constants.js";

/** AWS CloudControl API operation status values. */
export const CCAPIStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
} as const;

/** CloudControl HandlerErrorCode for "resource does not exist". */
export const CCAPI_NOT_FOUND_ERROR_CODE = "NotFound";

/**
 * Structured warn-level log line for non-fatal failures inside the destroy
 * pipeline. destroy-service has no LangGraph runId plumbed in, so we emit a
 * plain JSON object on stderr (matching the shape of the main logger) rather
 * than depending on ../utils/logger.ts which requires an action enum value.
 */
export function warnDestroy(
  action: string,
  extras: Record<string, unknown>,
): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        source: "destroy-service",
        action,
        extras,
      }) + "\n",
    );
  } catch {
    // stderr write failures are swallowed — never let logging break destroy.
  }
}

/**
 * Wave 11 P2-2: cross-account sanity check before treating a CCAPI
 * NotFound as success.
 *
 * Returns:
 *   - `"safe-shortcircuit"` when the ARN's account matches the
 *     operator's account (the legitimate "already gone" case), OR
 *     when either account is unknown (preserve Wave-5 behavior).
 *   - `"cross-account"` when the accounts differ — the caller should
 *     surface a real error explaining the mismatch instead of treating
 *     NotFound as success.
 */
export async function classifyNotFoundShortCircuit(
  resourceArn: string,
): Promise<"safe-shortcircuit" | "cross-account"> {
  const arnAccount = extractAccountIdFromArn(resourceArn);
  if (!arnAccount) return "safe-shortcircuit";

  // Lazy import to avoid pulling resolve-arn (and STS client) into
  // every code path that imports destroy-service. The cached
  // getOperatorAccountId helper amortizes the STS call across the
  // whole CLI process.
  const { getOperatorAccountId } = await import("../../utils/resolve-arn.js");
  const operatorAccount = await getOperatorAccountId();
  if (!operatorAccount) return "safe-shortcircuit";

  return arnAccount === operatorAccount ? "safe-shortcircuit" : "cross-account";
}

/**
 * Polls for delete completion using the CloudControlAdapter's getRequestStatus method.
 *
 * Returns `success: true` for both genuine SUCCESS and the FAILED+NotFound
 * combination. The latter happens when the bulk-destroy plan picks up a
 * resource from the Resource Groups Tagging API that has already been
 * deleted in AWS (the API continues to return tags for ~1 hour after
 * NAT Gateway/EIP deletion). The user's destroy intent is satisfied
 * either way — the resource is gone.
 */
export async function pollDeleteStatus(
  adapter: CloudControlAdapter,
  requestToken: string,
  resourceArn?: string,
): Promise<{ success: boolean; message?: string }> {
  for (let i = 0; i < DESTROY_MAX_POLL_ATTEMPTS; i++) {
    const [err, status] = await adapter.getRequestStatus(requestToken);
    if (err) {
      return { success: false, message: err.message };
    }

    if (status.operationStatus === CCAPIStatus.SUCCESS) {
      return { success: true };
    }
    if (status.operationStatus === CCAPIStatus.FAILED) {
      if (status.errorCode === CCAPI_NOT_FOUND_ERROR_CODE) {
        if (resourceArn) {
          const classification =
            await classifyNotFoundShortCircuit(resourceArn);
          if (classification === "cross-account") {
            return {
              success: false,
              message: `CloudControl reported NotFound for ${resourceArn}, but the operator credentials are configured for a different AWS account. The resource may exist in your intended account — verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
            };
          }
        }
        return { success: true };
      }
      return {
        success: false,
        message: status.statusMessage ?? "Delete operation failed",
      };
    }

    // IN_PROGRESS — wait and poll again
    await new Promise((resolve) =>
      setTimeout(resolve, DESTROY_POLL_INTERVAL_MS),
    );
  }

  return { success: false, message: "Delete operation timed out" };
}
