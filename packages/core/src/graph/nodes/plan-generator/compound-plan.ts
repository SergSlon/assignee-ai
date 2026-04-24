/**
 * Compound-mode plan generation for plan-generator.
 *
 * Runs when `state.resourcePattern` + `state.resourceQueue` +
 * `state.currentResourceIndex` are all set. Orchestrates a pipeline of
 * SRP-focused helpers (see `./compound-helpers.ts`):
 *
 *   1. Merge pattern defaults + elicited options (via toCfn).
 *   2. Inject human-readable CFN Name (+ CloudFront OAC special case).
 *   3. Construct Lambda↔IAM role ARN via STS (partition-aware).
 *   4. Resolve compound markers (apply-mode) or substitute placeholders
 *      (plan-mode + non-provisionable companions).
 *   5. EC2 AMI name → real ami-* id via SSM.
 *   6. Read pattern memory for "Using your usual X defaults" hint.
 *   7. Inject plugin-required defaults the pattern template forgot.
 *   8. EC2 SG/SSH scrub.
 */
import {
  ExecutionMode,
  ExecutionStatus,
  RESOURCE_TYPES,
  CfnKey,
  getPartitionFromRegion,
} from "@/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { resolveAmiFromOsName } from "@/utils/aws-resource-discovery/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";
import { applyToCfnTransforms } from "./cfn-emitter.js";
import {
  resolveCompoundMarkers,
  resolvePlaceholderMarkers,
  type AzLookup,
} from "./marker-resolver.js";
import { safeCloneDesiredState } from "./safe-clone.js";
import {
  injectCompoundResourceName,
  injectLambdaRoleArn,
  rewriteManagedPolicyArnsForPartition,
  readCompoundPatternMemoryHints,
  injectPluginRequiredDefaults,
  postProcessEc2Compound,
  filterElicitedForSlot,
} from "./compound-helpers.js";

/** Entrypoint for the compound path. Returns a partial AgentState. */
export async function runCompoundPlan(
  state: AgentState,
  azLookup?: AzLookup,
): Promise<Partial<AgentState>> {
  const currentResource = state.resourceQueue![state.currentResourceIndex!];
  if (!currentResource) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Compound resource index ${state.currentResourceIndex} out of bounds (queue length ${state.resourceQueue!.length})`,
    };
  }

  const patternDefaults =
    (state.resourcePattern!.defaultOptions[currentResource.resourceId] as
      | Record<string, unknown>
      | undefined) ?? {};
  // e96.W1.B1 — drop name-fields bound to a different resource type before
  // spreading into the slot's desiredState. Without this, a user-asserted
  // `FunctionName` (extracted by intent-parser because the primary resource
  // is Lambda) leaks into the IAM Role slot and CCAPI rejects the apply
  // with `extraneous key [FunctionName] is not permitted`.
  const rawOptions = filterElicitedForSlot(
    state.elicitedOptions ?? {},
    currentResource.resourceType,
  );
  const transformedOptions = applyToCfnTransforms(
    rawOptions,
    currentResource.resourceType,
  );
  const desiredState: Record<string, unknown> = {
    ...patternDefaults,
    ...transformedOptions,
  };

  injectCompoundResourceName(desiredState, currentResource, state.runId);

  // W-010: Rewrite AWS-managed policy ARNs to use the correct partition.
  // Pattern `defaultOptions` are static objects seeded with commercial-
  // partition ARNs (`arn:aws:iam::aws:policy/...`). In GovCloud, China, and
  // ISO partitions the prefix differs; this call replaces the commercial prefix
  // with `arn:<partition>:iam::aws:policy/` for ManagedPolicyArns + PermissionsBoundary.
  rewriteManagedPolicyArnsForPartition(
    desiredState,
    getPartitionFromRegion(AWS_REGION),
  );

  await injectLambdaRoleArn(desiredState, currentResource, state);

  // Compound marker resolution must run before CloudControl sees the
  // desiredState — CloudControl does NOT process CloudFormation intrinsics.
  //
  // PLAN mode OR non-provisionable companions: substitute display-only
  // placeholders (no AWS calls) instead of resolving against completed
  // resources (which don't exist yet / never will).
  const isNonProvisionableCompanion = currentResource.provisionable === false;
  if (
    state.executionMode === ExecutionMode.PLAN ||
    isNonProvisionableCompanion
  ) {
    // Deep-copy before placeholder mutation — the shallow spread at
    // assembly time shares nested arrays with patternDefaults. Without
    // this deep copy, a PLAN-mode pass on resource N corrupts shared
    // arrays, and a subsequent APPLY-mode pass on resource M sees
    // placeholders instead of markers.
    const deepCopy = safeCloneDesiredState(
      desiredState,
      currentResource.resourceId,
    );
    for (const k of Object.keys(desiredState)) delete desiredState[k];
    Object.assign(desiredState, deepCopy);
    resolvePlaceholderMarkers(desiredState, AWS_REGION);
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      extras: {
        phase: "compound_marker_placeholder",
        resourceId: currentResource.resourceId,
        executionMode: state.executionMode,
        provisionable: currentResource.provisionable,
      },
    });
  } else {
    try {
      await resolveCompoundMarkers(desiredState, {
        completedResources: state.completedResources ?? [],
        region: AWS_REGION,
        currentResourceId: currentResource.resourceId,
        azLookup,
      });
    } catch (resolveErr) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
      };
    }

    // Compound EC2 AMI resolution: defaultOptions.ImageId may contain an
    // OS name that must be resolved to a real ami-* id via SSM before CCAPI.
    if (
      currentResource.resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
      typeof desiredState[CfnKey.IMAGE_ID] === "string" &&
      !String(desiredState[CfnKey.IMAGE_ID]).startsWith("ami-")
    ) {
      const osName = String(desiredState[CfnKey.IMAGE_ID]);
      const resolvedAmi = await resolveAmiFromOsName(osName);
      if (resolvedAmi) {
        desiredState[CfnKey.IMAGE_ID] = resolvedAmi;
      } else {
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Cannot resolve "${osName}" to a real AMI ID for compound EC2 instance "${currentResource.resourceId}". Check AWS credentials and SSM access.`,
        };
      }
    }
  }

  const compoundMemoryHints = await readCompoundPatternMemoryHints(state);
  injectPluginRequiredDefaults(desiredState, currentResource, state.runId);
  postProcessEc2Compound(desiredState, currentResource, state.userIntent);

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PLAN_GENERATED,
    durationMs: 0,
    extras: { resourceType: currentResource.resourceType, compound: true },
  });
  return {
    desiredState,
    resourceType: currentResource.resourceType,
    ...(compoundMemoryHints.length > 0
      ? { memoryHints: compoundMemoryHints }
      : {}),
  };
}
