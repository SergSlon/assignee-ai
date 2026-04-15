/**
 * Delete dispatcher — delegates to the MCP destroy-strategies registry.
 *
 * Responsibilities:
 * - Classify a CCAPI NotFound against the operator's own account to catch
 *   cross-account misconfiguration (tag API caches deleted resources ~1h, so
 *   NotFound usually means "already gone", except when the operator is
 *   pointed at the wrong AWS account).
 * - Poll CloudControl for terminal status with transient-error tolerance.
 */

import {
  CloudControlClient,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import type { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { extractAccountIdFromArn } from "@assignee/core";
import { destroyRegistry } from "../../services/destroy-strategies/index.js";
import { getOperatorAccountId } from "./sts-cache.js";
import { isArn, verifyArnIsManaged } from "./resolve.js";
import type { ResolvedResource } from "./types.js";
import {
  CCAPI_NOT_FOUND_ERROR_CODE,
  EXTENDED_POLL_ATTEMPTS,
  MAX_POLL_ATTEMPTS,
  POLL_INTERVAL_MS,
  type PollResult,
} from "./types.js";

/**
 * Classifies a CCAPI NotFound response by comparing the resource ARN's
 * account to the operator's account. If they match (or account info is
 * unavailable), treat NotFound as success. If they differ, the operator
 * is almost certainly pointing at the wrong account — surface a real error.
 */
export async function classifyNotFoundShortCircuit(
  resourceArn: string,
  region: string,
): Promise<"safe-shortcircuit" | "cross-account"> {
  const arnAccount = extractAccountIdFromArn(resourceArn);
  if (!arnAccount) return "safe-shortcircuit";
  const operatorAccount = await getOperatorAccountId(region);
  if (!operatorAccount) return "safe-shortcircuit";
  return arnAccount === operatorAccount ? "safe-shortcircuit" : "cross-account";
}

/**
 * Pre-delete re-verification — closes the verify-to-delete TOCTOU window.
 *
 * `resolveResource` calls `verifyArnIsManaged` at resolve time; this call
 * re-verifies the tag **immediately before** we dispatch `DeleteResource`
 * so an attacker holding `tag:UntagResources` (but not
 * `cloudcontrol:DeleteResource`) cannot strip the `managed-by=assignee-ai`
 * tag between resolve and delete and trick us into deleting an unmanaged
 * resource.
 *
 * Composite-identifier resources (e.g. `AWS::EC2::Route`) have no ARN and
 * no tag, so the second verify is meaningless for them — bypass cleanly.
 *
 * Does NOT swallow RGTA errors. If the second verify throws, the caller
 * must abort (fail-closed) — there's no way to prove the tag is intact
 * so we cannot proceed safely. See story 48.4 Dev Notes.
 *
 * @see docs/explanation/invariants.md "Destroy TOCTOU window"
 */
export async function verifyTagBeforeDelete(
  resolved: ResolvedResource,
  taggingClient: ResourceGroupsTaggingAPIClient,
  startTimeMs: number,
  region: string,
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: "tag-missing";
      warnLine: string;
      accountMatch: boolean;
    }
> {
  // Composite-identifier resources (e.g. Route "rtb-xxx|0.0.0.0/0") have
  // no ARN and no managed-by tag — second verify is meaningless.
  if (!isArn(resolved.arn)) return { ok: true };

  const stillManaged = await verifyArnIsManaged(resolved.arn, taggingClient);
  if (stillManaged) return { ok: true };

  // Compute accountMatch for the SECURITY log line. Re-use the STS cache
  // (no extra STS call per destroy). If either side is unknown, log false.
  const operatorAccount = await getOperatorAccountId(region);
  const arnAccount = extractAccountIdFromArn(resolved.arn);
  const accountMatch = Boolean(
    operatorAccount && arnAccount && operatorAccount === arnAccount,
  );
  const elapsedMs = Date.now() - startTimeMs;
  const warnLine = `[destroy_resource][SECURITY] toctou-tag-missing arn=${resolved.arn} firstVerify=managed secondVerify=unmanaged accountMatch=${accountMatch} elapsedMs=${elapsedMs}`;

  return { ok: false, reason: "tag-missing", warnLine, accountMatch };
}

export async function pollDeleteStatus(
  ccClient: CloudControlClient,
  requestToken: string,
  resourceType?: string,
  resourceArn?: string,
  region?: string,
): Promise<PollResult> {
  const MAX_TRANSIENT_ERRORS = 3;
  let transientErrors = 0;
  const strategy = resourceType ? destroyRegistry.get(resourceType) : undefined;
  const maxAttempts = strategy?.isSlow
    ? EXTENDED_POLL_ATTEMPTS
    : MAX_POLL_ATTEMPTS;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await ccClient.send(
        new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
      );
      const status = result.ProgressEvent?.OperationStatus;
      const errorCode = result.ProgressEvent?.ErrorCode;

      if (status === "SUCCESS") return { success: true };
      if (status === "FAILED") {
        if (errorCode === CCAPI_NOT_FOUND_ERROR_CODE) {
          if (resourceArn && region) {
            const classification = await classifyNotFoundShortCircuit(
              resourceArn,
              region,
            );
            if (classification === "cross-account") {
              return {
                success: false,
                message: `CloudControl reported NotFound for ${resourceArn}, but the operator credentials are configured for a different AWS account. Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
              };
            }
          }
          return { success: true };
        }
        return {
          success: false,
          message:
            result.ProgressEvent?.StatusMessage ?? "Delete operation failed",
        };
      }
    } catch (err) {
      transientErrors++;
      if (transientErrors >= MAX_TRANSIENT_ERRORS) {
        return {
          success: false,
          message: `Poll error (after ${transientErrors} transient failures): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { success: false, message: "Delete operation timed out" };
}

/**
 * Executes the pre-destroy hook registered for a resource type, if any.
 * Non-fatal — CloudControl will surface a clearer error if the hook fails.
 */
export async function runPreDestroyHook(
  resourceType: string,
  identifier: string,
  region: string,
): Promise<void> {
  const strategy = destroyRegistry.get(resourceType);
  if (!strategy?.preDestroy) return;
  try {
    await strategy.preDestroy(identifier, region);
  } catch (preErr: unknown) {
    const msg = preErr instanceof Error ? preErr.message : String(preErr);
    console.error(
      `[destroy_resource] pre-destroy warning for ${resourceType} ${identifier}: ${msg}`,
    );
  }
}
