/**
 * Single-resource destroy flow.
 *
 * Wave 2 P1-6 + Wave 5 F3: typed-name confirmation (case-insensitive, trim,
 * trailing-slash strip, full-ARN fallback). See `./typed-confirm.ts`.
 */

import * as clack from "@clack/prompts";
import {
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
  CostEstimateLabel,
  findProvisionRecord,
  isNonTaggableConstruct,
  extractIdentifierFromArn,
  arnToResourceType,
  appendDestroyedArn,
} from "@assignee/core";
import { maybeDestroySshBundleIamForArn } from "@assignee/core/graph";
import { getCostSavingsEstimate } from "../../services/billing.js";
import { getBillingMcpToolsAsync } from "../../services/mcp-client.js";
import { startSpinner, stopSpinner } from "../../utils/display.js";
import {
  resolveResource,
  createTaggingClient,
  isAmbiguousResolution,
  type ResolvedResource,
} from "../../services/resource-resolver.js";
import { pickFromMatches } from "./multi-match-prompt.js";
import { tryAssigneeCredentials } from "../../config/aws-credentials.js";
import { AWS_REGION, UserMessage } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import { destroySingleResource } from "../../services/destroy-service.js";
import { resourceConfirmationToken } from "./typed-confirm.js";
import { renderDestroyBox, renderDestroySuccess } from "./result-formatter.js";
import { maybeWarnYesInTty } from "./yes-warning.js";

/** Handles single-resource destroy. `resource` must be set by caller. */
export async function singleDestroyAction(
  resource: string,
  opts: { yes?: boolean; noConfirm?: boolean },
): Promise<void> {
  // ── Initialize AWS clients ────────────────────────────────────────
  const opCreds = tryAssigneeCredentials("operator");
  const awsConfig = {
    accessKeyId: opCreds?.accessKeyId ?? "",
    secretAccessKey: opCreds?.secretAccessKey ?? "",
    ...(opCreds?.sessionToken ? { sessionToken: opCreds.sessionToken } : {}),
    region: AWS_REGION,
  };
  let taggingClient;
  try {
    taggingClient = createTaggingClient(awsConfig);
  } catch {
    throw new ConfigurationError(
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee dev setup`.",
    );
  }

  // ── Resolve resource ────────────────────────────────────────────
  startSpinner("Resolving resource...");

  const resolution = await resolveResource(resource, taggingClient, AWS_REGION);

  stopSpinner();

  // ── Provision-log fallback ───────────────────────────────────────
  // RGTA misses two classes of managed resources:
  //   1. Non-taggable constructs (Route / SubnetRouteTableAssociation /
  //      VPCGatewayAttachment) — keyed by primaryIdentifier in the log.
  //   2. Taggable resources whose ARN format RGTA does not index (EIP:
  //      arn:…:elastic-ip/eipalloc-xxx). RGTA returns EIP tags but does
  //      NOT enumerate them under the elastic-ip ARN prefix; the destroy
  //      command got DESTROY_TARGET_NOT_FOUND even though the ARN was
  //      legitimately in the provision log (BUG-5 hotfix).
  // In both cases, fall through to the provision log before failing.
  let resolved: ResolvedResource;
  if (!resolution) {
    const provRecord = await findProvisionRecord(resource);
    if (!provRecord) {
      throw new AssigneeError(
        `No managed resource found matching "${resource}". Run 'assignee admin list' to see managed resources.`,
        ErrorCode.DESTROY_TARGET_NOT_FOUND,
      );
    }
    if (provRecord.keyKind === "primaryIdentifier") {
      // Non-taggable construct: identifier IS the CCAPI primaryIdentifier.
      if (!isNonTaggableConstruct(provRecord.resourceType)) {
        throw new AssigneeError(
          `No managed resource found matching "${resource}". Run 'assignee admin list' to see managed resources.`,
          ErrorCode.DESTROY_TARGET_NOT_FOUND,
        );
      }
      resolved = {
        arn: "",
        resourceType: provRecord.resourceType,
        region: provRecord.region || awsConfig.region || AWS_REGION,
        tags: {},
        identifier: provRecord.key,
      };
    } else {
      // ARN-keyed record: RGTA didn't enumerate this resource (e.g. EIP).
      // Synthesize a ResolvedResource from the provision log. The identifier
      // is extracted from the ARN (elastic-ip/eipalloc-xxx → eipalloc-xxx).
      const resolvedType =
        arnToResourceType(provRecord.key) ?? provRecord.resourceType;
      resolved = {
        arn: provRecord.key,
        resourceType: resolvedType,
        region: provRecord.region || awsConfig.region || AWS_REGION,
        tags: {},
        identifier: extractIdentifierFromArn(provRecord.key),
      };
    }
  } else {
    // Story 48.6: multi-match disambiguation — user picks one, or --yes /
    // non-TTY stdin fails fast with an actionable error. Zero AWS mutation
    // calls fire before disambiguation completes.
    resolved = isAmbiguousResolution(resolution)
      ? await pickFromMatches(resolution, { yes: opts.yes })
      : resolution;
  }

  // ── Estimate cost savings (Story 19.7) ──────────────────────────
  const billingTools = await getBillingMcpToolsAsync();
  // Defect 3 fix (2026-05-09): thread resourceType so the estimator
  // can fall back to the per-type decomposer registry when MCP +
  // provision-log are both silent.
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    resolved.resourceType,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== CostEstimateLabel.NA
      ? savingsEstimate
      : "(cost data unavailable)";

  renderDestroyBox({
    resourceType: resolved.resourceType,
    arn: resolved.arn,
    region: resolved.region,
    identifier: resolved.identifier,
    estimatedMonthlyCost,
  });

  // ── Confirmation prompt ─────────────────────────────────────────
  if (opts.yes) {
    // Suppressed when the bulk-destroy orchestrator threads `noConfirm`
    // through after its own typed-account-ID confirmation; otherwise
    // emits once per interactive `destroy --yes` invocation.
    maybeWarnYesInTty(opts);
  } else {
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Destroy requires confirmation. Use --yes for non-interactive mode.",
        ErrorCode.DESTROY_ERROR,
      );
    }

    // Wave-2 P1-6 / Wave 5 F3 typed-name confirm (case-insensitive, trim).
    const confirmToken = resourceConfirmationToken(resolved);
    const answer = await clack.text({
      message: `Type '${confirmToken}' to confirm destruction, or anything else to cancel:`,
    });

    if (
      clack.isCancel(answer) ||
      typeof answer !== "string" ||
      answer.trim().toLowerCase() !== confirmToken.toLowerCase()
    ) {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }
  }

  // ── Delete resource ─────────────────────────────────────────────
  startSpinner("Destroying resource...");

  const result = await destroySingleResource(resolved, {
    region: resolved.region,
  });

  stopSpinner();

  if (!result.success) {
    throw new AssigneeError(
      result.error ??
        `Destroy call returned no error message — the resource may already be gone or AWS accepted the call without confirming. Run \`assignee admin list\` to verify, and check \`~/.assignee/logs/\` for the full structured trace.`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  // Record destroyed ARN so list filters it while AWS keeps the resource
  // in INACTIVE state (ECS clusters linger ~1h after deletion, BUG-9).
  await appendDestroyedArn("", result.arn);

  // SSH-bundle IAM cleanup (audit 2026-05-05 H3) — for EC2 instances,
  // tear down the auto-created `assignee-ssh-<runId-suffix>` IAM role +
  // instance profile so they don't accumulate as orphans across destroy
  // cycles. Best-effort at TWO layers: the helper itself swallows every
  // step's failure and returns a warnings array; this call site wraps
  // in try/catch as defense-in-depth so a hypothetical helper bug
  // (uncaught throw) cannot fail the destroy command — the EC2 itself
  // was already successfully destroyed and surfacing IAM cleanup
  // failures to stderr would confuse the operator about whether the
  // primary destroy worked. See
  // `packages/core/src/graph/nodes/resource-provisioner/ssh-iam-destroy.ts`
  // for the deterministic name-derivation + idempotent teardown
  // sequence.
  try {
    await maybeDestroySshBundleIamForArn(
      result.arn,
      resolved.resourceType,
      resolved.region,
    );
  } catch {
    // Helper claims to never throw; defense-in-depth swallow keeps the
    // contract enforceable at the call site even if that claim ever
    // regresses. The helper's internal log emits already cover
    // observability — no double-log here.
  }

  renderDestroySuccess(estimatedMonthlyCost);
}
