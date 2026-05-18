/**
 * Phase helpers for the destroy_resource MCP tool.
 *
 * Story 53-it1-09 refactor: the pre-refactor entrypoint was a 282 LOC
 * body with 4 nested try/catches and 6-level nesting. Each discrete
 * phase of the destroy pipeline (resolve → redirect/fallback guard →
 * pre-destroy hook → TOCTOU re-verify → CCAPI delete → poll → audit)
 * now lives here as a focused helper returning a discriminated result
 * so the orchestrator is a flat sequence of early-return steps.
 *
 * Invariants preserved by this module (cited per project memory):
 * - CCAPI NotFound short-circuit for both synchronous DeleteResource
 *   errors and async poll FAILED+ErrorCode=NotFound
 *   (feedback_cloudcontrol_notfound_short_circuit).
 * - Pre-destroy hooks for IGW/RouteTable dispatched via the strategy
 *   registry (feedback_destroy_predelete_hooks_for_cfn_only_constructs).
 * - Partition-aware ARN matching / placeholder-ARN preflight are
 *   owned by `resolve.ts` and `verifyTagBeforeDelete`; this module
 *   does not re-implement either check.
 * - Redaction — only allowlisted audit fields are passed to
 *   `logDestroyAudit` (feedback_redaction_allowlist_not_denylist).
 */

import {
  CloudControlClient,
  DeleteResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import type { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  MissingAssigneeCredentialsError,
  findProvisionRecord,
  isNonTaggableConstruct,
  appendDestroyedArn,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import {
  buildErrorResponse,
  buildSuccessResponse,
  DESTROY_ERROR_CODES,
  type McpToolResponse,
} from "./error-envelope.js";
import {
  classifyNotFoundShortCircuit,
  pollDeleteStatus,
  runPreDestroyHook,
  verifyTagBeforeDelete,
} from "./dispatcher.js";
import { isArn, resolveResource } from "./resolve.js";
import type { ResolvedResource } from "./types.js";
import { mcpLogWarn } from "../../utils/structured-log.js";
import { logDestroyAudit } from "./audit.js";
import type { StepResult } from "../../utils/step-result.js";

/** Resolve the caller's identifier into a ResolvedResource or bail. */
export async function resolveStep(
  identifier: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<StepResult<ResolvedResource>> {
  let resolved: ResolvedResource | null;
  try {
    resolved = await resolveResource(identifier, taggingClient, region);
  } catch (err) {
    return {
      kind: "done",
      response: buildErrorResponse(
        `Failed to resolve resource: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  if (!resolved) {
    // Epic 98 e98.W1.B1 (B-02) mirror: RGTA never returns Route / SRTA /
    // VPCGatewayAttachment because AWS doesn't tag those. Fall back to
    // the provision log by primaryIdentifier so MCP destroy closes the
    // same gap the CLI closed. Matches `apps/cli/src/commands/destroy/
    // single-flow.ts`.
    const nonTaggable = await findProvisionRecord(identifier);
    if (nonTaggable && isNonTaggableConstruct(nonTaggable.resourceType)) {
      return {
        kind: "continue",
        context: {
          arn: "",
          resourceType: nonTaggable.resourceType,
          region: nonTaggable.region || region,
          identifier: nonTaggable.key,
        },
      };
    }
    return { kind: "done", response: unresolvedResponse(identifier) };
  }
  return { kind: "continue", context: resolved };
}

/** Build the "not found in RGTA" response with the right hint. */
function unresolvedResponse(identifier: string): McpToolResponse {
  const isArnInput = isArn(identifier);
  const message = isArnInput
    ? `Could not verify "${identifier}" is managed by assignee.ai. The Resource Groups Tagging API did not return this ARN with a managed-by=assignee-ai tag after retries. Destroy was refused for safety.`
    : `No managed resource found matching "${identifier}". Use list_managed_resources to see available resources.`;
  const hint = isArnInput
    ? "Only resources tagged managed-by=assignee-ai can be destroyed via this tool. If the resource was just created, the tagging API may not have indexed it yet — wait a minute and retry. If the resource is not managed by assignee.ai, delete it through the AWS Console or CLI."
    : undefined;
  return buildErrorResponse(message, hint);
}

/** Build the PENDING_CONFIRMATION payload for a dry-run invocation. */
export function dryRunResponse(resolved: ResolvedResource): McpToolResponse {
  return buildSuccessResponse({
    status: "PENDING_CONFIRMATION",
    message:
      "Resource resolved. Set confirmed: true to proceed with destruction.",
    resource: {
      arn: resolved.arn,
      resourceType: resolved.resourceType,
      region: resolved.region,
      identifier: resolved.identifier,
    },
    hint: "Present these details to the user and get explicit approval before setting confirmed: true.",
  });
}

/**
 * Reject resource types that cannot flow through the CCAPI delete
 * path (redirect types) or that require an SDK fallback which the
 * MCP server does not yet host.
 */
export function guardUnsupportedTypes(
  resolved: ResolvedResource,
  originalIdentifier: string,
): StepResult {
  if (CCAPI_REDIRECT_TYPES[resolved.resourceType]) {
    return {
      kind: "done",
      response: buildErrorResponse(
        `${resolved.resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
      ),
    };
  }
  const fallbackSet = new Set(Object.values(CCAPI_FALLBACK_TYPES) as string[]);
  if (fallbackSet.has(resolved.resourceType)) {
    return {
      kind: "done",
      response: buildErrorResponse(
        `${resolved.resourceType} requires SDK fallback deletion which is not yet supported in the MCP server. Use the CLI: assignee infra destroy ${originalIdentifier}`,
      ),
    };
  }
  return { kind: "continue", context: undefined };
}

/** Construct a scoped CloudControl client in the resolved region. */
export function buildCcClient(
  resolved: ResolvedResource,
  credentials: ExplicitAwsCredentials,
): StepResult<CloudControlClient> {
  try {
    const client = new CloudControlClient({
      region: resolved.region,
      credentials,
    });
    return { kind: "continue", context: client };
  } catch (err) {
    return {
      kind: "done",
      response: buildErrorResponse(
        `Failed to initialize CloudControl client: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

/**
 * Invoke the pre-destroy hook (IGW detach / RouteTable disassociate /
 * etc). Only `MissingAssigneeCredentialsError` is fatal and returned
 * to the caller; every other hook failure is already logged+swallowed
 * inside the dispatcher. Any other thrown error is re-thrown so the
 * surrounding handler can catch it.
 */
export async function runPreDestroyStep(
  resolved: ResolvedResource,
): Promise<StepResult> {
  try {
    await runPreDestroyHook(
      resolved.resourceType,
      resolved.identifier,
      resolved.region,
    );
    return { kind: "continue", context: undefined };
  } catch (preHookErr: unknown) {
    if (preHookErr instanceof MissingAssigneeCredentialsError) {
      return {
        kind: "done",
        response: buildErrorResponse(
          `Pre-destroy hook for ${resolved.resourceType} needs operator credentials: ${preHookErr.message}`,
          "Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY in the MCP server environment, or run 'assignee dev setup' to create the IAM users, then retry the destroy.",
        ),
      };
    }
    throw preHookErr;
  }
}

/**
 * TOCTOU re-verification immediately before DeleteResource. Closes
 * the resolve→delete race where an attacker with tag:UntagResources
 * could strip the managed-by tag after we resolved (Story 48.4).
 * Composite-identifier resources (no ARN) bypass internally.
 */
export async function toctouReverifyStep(
  resolved: ResolvedResource,
  taggingClient: ResourceGroupsTaggingAPIClient,
  resolveStartMs: number,
): Promise<StepResult> {
  try {
    const recheck = await verifyTagBeforeDelete(
      resolved,
      taggingClient,
      resolveStartMs,
      resolved.region,
    );
    if (!recheck.ok) {
      // Intentionally unredacted: operator owns the ARN by virtue of
      // the first verify passing, and the SOC needs it for forensic
      // CloudTrail correlation. See feedback_redaction_allowlist_not_denylist.
      mcpLogWarn(
        "destroy-resource",
        "toctou_tag_missing",
        { warnLine: recheck.warnLine },
        recheck.warnLine,
      );
      return {
        kind: "done",
        response: buildErrorResponse(
          `Destroy refused: the managed-by=assignee-ai tag on ${resolved.arn} was stripped between resolve and delete. The resource was NOT deleted.`,
          "Investigate immediately — an external principal removed the managed-by tag mid-flight. Check CloudTrail for UntagResources events on this ARN and review IAM policies granting tag:UntagResources.",
          DESTROY_ERROR_CODES.TOCTOU_TAG_MISSING,
        ),
      };
    }
    return { kind: "continue", context: undefined };
  } catch (err) {
    // Fail-closed: if the second verify throws (RGTA error), we cannot
    // prove the tag is still present, so refuse the delete rather than
    // racing on a best-effort guess.
    return {
      kind: "done",
      response: buildErrorResponse(
        `Pre-delete tag re-verification failed: ${err instanceof Error ? err.message : String(err)}. The resource was NOT deleted.`,
        "RGTA was unreachable at the pre-delete check. Retry once the Resource Groups Tagging API is healthy.",
      ),
    };
  }
}

/**
 * Dispatch the DeleteResource command and poll for completion.
 * Emits the success audit record on the happy path, plus targeted
 * failure audits for NoRequestToken and poll-failure outcomes.
 */
export async function dispatchDeleteAndPoll(
  ccClient: CloudControlClient,
  resolved: ResolvedResource,
): Promise<McpToolResponse> {
  const deleteResult = await ccClient.send(
    new DeleteResourceCommand({
      TypeName: resolved.resourceType,
      Identifier: resolved.identifier,
    }),
  );
  const requestToken = deleteResult.ProgressEvent?.RequestToken;
  if (!requestToken) {
    await logDestroyAudit(resolved, {
      kind: "failure",
      errorClass: "NoRequestToken",
    });
    return buildErrorResponse(
      "DeleteResource returned no request token — cannot track operation status.",
    );
  }

  const pollResult = await pollDeleteStatus(
    ccClient,
    requestToken,
    resolved.resourceType,
    resolved.arn,
    resolved.region,
  );

  if (!pollResult.success) {
    await logDestroyAudit(resolved, {
      kind: "failure",
      errorClass: "PollFailure",
    });
    return buildErrorResponse(`Destroy failed: ${pollResult.message}`);
  }

  // Story 50-5 H-3: persistent audit record for the success path.
  await logDestroyAudit(resolved, { kind: "success" });
  return await successResponse(resolved, "destroyed successfully");
}

/**
 * Classify an error thrown by DeleteResource and produce the right
 * MCP response. Split out so the main orchestrator owns a single
 * top-level catch and the branch logic is linear.
 */
export async function classifyDestroyError(
  err: unknown,
  resolved: ResolvedResource,
): Promise<McpToolResponse> {
  const errName = err instanceof Error ? err.name : "";
  const errMsg = err instanceof Error ? err.message : String(err);
  const isNotFound =
    errName === "ResourceNotFoundException" ||
    /ResourceNotFoundException|NotFound/.test(errMsg);
  if (isNotFound) {
    return handleNotFoundShortCircuit(resolved);
  }
  await logDestroyAudit(resolved, {
    kind: "failure",
    errorClass: errName || "DestroyError",
  });
  return buildErrorResponse(`Failed to destroy resource: ${errMsg}`);
}

/**
 * CCAPI NotFound short-circuit. Verifies the failure is same-account
 * (not a cross-account config mishap) then treats it as a delete
 * success — RGTA caches deleted resource tags for ~1h.
 * Preserves feedback_cloudcontrol_notfound_short_circuit.
 */
async function handleNotFoundShortCircuit(
  resolved: ResolvedResource,
): Promise<McpToolResponse> {
  const classification = await classifyNotFoundShortCircuit(
    resolved.arn,
    resolved.region,
  );
  if (classification === "cross-account") {
    await logDestroyAudit(resolved, {
      kind: "failure",
      errorClass: "CrossAccountNotFound",
    });
    return buildErrorResponse(
      `CloudControl reported NotFound for ${resolved.arn}, but the operator credentials are configured for a different AWS account. Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
    );
  }
  await logDestroyAudit(resolved, { kind: "success" });
  return await successResponse(resolved, "was already deleted (NotFound)");
}

/** Standard SUCCESS response — used by both the happy path and the NotFound short-circuit. */
async function successResponse(
  resolved: ResolvedResource,
  verb: string,
): Promise<McpToolResponse> {
  // Record the ARN so fetchManagedResources filters it from list output
  // while AWS keeps the resource in INACTIVE state (BUG-9).
  await appendDestroyedArn("", resolved.arn);
  return buildSuccessResponse({
    status: "SUCCESS",
    message: `Resource ${resolved.arn} ${verb}.`,
    resource: {
      arn: resolved.arn,
      resourceType: resolved.resourceType,
      region: resolved.region,
      identifier: resolved.identifier,
    },
  });
}
