/**
 * destroy-service.ts — Thin dispatcher for destroying a single AWS
 * resource. Consults the `destroyRegistry` for per-type behavior
 * (preDestroy / full destroy / postDestroy) and falls back to the
 * generic CloudControl API delete path when no type-specific
 * `destroy` hook is registered.
 *
 * Returns a structured `DestroyResult` instead of throwing, making it
 * composable for both interactive single-destroy and bulk-destroy
 * flows.
 *
 * @see Wave-6 F1a — strategy scaffolding
 * @see Wave-6 F1b — complex per-type strategies extracted
 */

import { CCAPI_REDIRECT_TYPES } from "@assignee/core";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import {
  destroyRegistry,
  warnDestroy,
  pollDeleteStatus,
  classifyNotFoundShortCircuit,
  type DestroyContext,
  type DestroyStrategy,
} from "./destroy-strategies/index.js";
import { ProvisioningErrorKind } from "./provisioning-port.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { AWS_REGION } from "../config/constants.js";

export interface DestroyResult {
  success: boolean;
  resourceType: string;
  identifier: string;
  arn: string;
  error?: string;
}

export interface DestroyOptions {
  region?: string;
  silent?: boolean; // suppress spinner/output for bulk mode
  onProgress?: (message: string) => void;
}

/**
 * Run the generic CloudControl DeleteResource path (used when no
 * strategy declares a full `destroy` hook). Returns a partial result
 * shape; the caller stitches in the common metadata.
 */
async function runCloudControlDelete(
  strategy: DestroyStrategy | undefined,
  ctx: DestroyContext,
): Promise<{ success: boolean; error?: string }> {
  const { resource, awsConfig, effectiveRegion } = ctx;
  try {
    const ccClient = createCloudControlClient(awsConfig);
    const adapter = new CloudControlAdapter(ccClient);

    // CloudControl identifier resolution:
    //  - strategy.extractIdentifier(...) overrides (reserved for custom derivation)
    //  - strategy.usesArnIdentifier=true → use the full ARN
    //  - default → use resource.identifier
    const ccIdentifier = strategy?.extractIdentifier
      ? strategy.extractIdentifier(
          resource.arn,
          resource.identifier,
          effectiveRegion,
        )
      : strategy?.usesArnIdentifier
        ? resource.arn
        : resource.identifier;

    const [deleteErr, deleteResult] = await adapter.deleteResource(
      resource.resourceType,
      ccIdentifier,
    );

    if (deleteErr) {
      // NOT_FOUND → resource is already gone (the desired end-state).
      // Wave-11 P2-2 cross-account sanity check: guard against silent
      // success when the operator credentials point at a different
      // AWS account than the resource ARN.
      if (deleteErr.kind === ProvisioningErrorKind.NOT_FOUND) {
        const classification = await classifyNotFoundShortCircuit(resource.arn);
        if (classification === "cross-account") {
          return {
            success: false,
            error: `CloudControl reported NotFound for ${resource.arn}, but the operator credentials are configured for a different AWS account. The resource may exist in your intended account — verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
          };
        }
        return { success: true };
      }
      return {
        success: false,
        error: `Failed to destroy resource: ${deleteErr.message}`,
      };
    }

    // Poll for delete completion (pass resource.arn so the cross-account
    // sanity check can fire on FAILED+NotFound poll results too).
    const pollResult = await pollDeleteStatus(
      adapter,
      deleteResult.requestToken,
      resource.arn,
    );

    if (!pollResult.success) {
      return {
        success: false,
        error: `Destroy failed: ${pollResult.message}`,
      };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to destroy resource: ${message}`,
    };
  }
}

/**
 * Destroys a single AWS resource.
 *
 * Orchestration:
 *   1. Redirect-type guard.
 *   2. Resolve operator credentials + effective region (promote "global").
 *   3. Look up the registered strategy (undefined → generic path).
 *   4. `strategy.preDestroy(ctx)` — may abort with a failure result.
 *   5. `strategy.destroy(ctx)` if defined, else the generic CCAPI path.
 *   6. `strategy.postDestroy(ctx)` on success (non-fatal failures logged).
 */
export async function destroySingleResource(
  resource: {
    arn: string;
    resourceType: string;
    identifier: string;
    region: string;
  },
  options?: DestroyOptions,
): Promise<DestroyResult> {
  const baseResult: Pick<DestroyResult, "resourceType" | "identifier" | "arn"> =
    {
      resourceType: resource.resourceType,
      identifier: resource.identifier,
      arn: resource.arn,
    };

  // ── Redirect types cannot be deleted ─────────────────────────────────
  if (CCAPI_REDIRECT_TYPES[resource.resourceType]) {
    return {
      ...baseResult,
      success: false,
      error: `${resource.resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
    };
  }

  // ── Resolve AWS credentials + region ─────────────────────────────────
  // Wave 19 Bug #9: IAM is a global service. The bulk-destroy plan tags
  // IAM resources with `region: "global"` (matching how list-resources.ts
  // reports them), and the CLI's destroy command passes that through to
  // destroySingleResource as `options.region`. Without remapping, the
  // CloudControl SDK builds an endpoint of `cloudcontrolapi.global.amazonaws.com`,
  // which doesn't exist. Always promote "global" to a real
  // Bedrock-eligible region (us-east-1 is the canonical IAM control-plane
  // region).
  const requestedRegion = options?.region;
  const effectiveRegion =
    requestedRegion === "global" || !requestedRegion
      ? AWS_REGION
      : requestedRegion;
  const awsConfig: AwsConfig = {
    ...operatorCredentials(),
    region: effectiveRegion,
  };

  const strategy = destroyRegistry.get(resource.resourceType);
  const ctx: DestroyContext = {
    resource,
    awsConfig,
    effectiveRegion,
    onProgress: options?.onProgress,
    warn: warnDestroy,
  };

  // ── Pre-destroy hook ─────────────────────────────────────────────────
  if (strategy?.preDestroy) {
    const preOutcome = await strategy.preDestroy(ctx);
    if (preOutcome && preOutcome.success === false) {
      return {
        ...baseResult,
        success: false,
        error: preOutcome.error,
      };
    }
  }

  // ── Primary delete: strategy-owned full destroy OR generic CCAPI ────
  const deleteOutcome = strategy?.destroy
    ? await strategy.destroy(ctx)
    : await runCloudControlDelete(strategy, ctx);

  if (!deleteOutcome.success) {
    return {
      ...baseResult,
      success: false,
      error: deleteOutcome.error,
    };
  }

  // ── Post-destroy hook (non-fatal) ────────────────────────────────────
  if (strategy?.postDestroy) {
    try {
      await strategy.postDestroy(ctx);
    } catch (err) {
      // Strategy is responsible for non-fatal logging; outer try/catch
      // is a safety net so post-hook bugs can never fail an otherwise
      // successful destroy.
      warnDestroy("post_destroy_hook_unhandled", {
        resourceType: resource.resourceType,
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ...baseResult, success: true };
}
