/**
 * LLM-plan phase 4: resource-specific post-processing.
 *
 * Exposes two steps (the orchestrator interleaves them with required-field
 * repair to preserve the pre-refactor execution order):
 *
 *   1. `preRepairPostProcess` — runs BEFORE `repairRequiredFields`:
 *      - EC2 AMI resolution: maps a human OS name (e.g., "Ubuntu 22.04")
 *        to a real `ami-...` ID via SSM public parameters. Short-circuits
 *        to FAILED on resolution miss. Must run before repair because
 *        repair can fill ImageId with an OS-name default which must NOT
 *        be resolved (mirrors the pre-refactor semantics).
 *      - NAT Gateway EIP placeholder: inserts `EIP_AUTO_ALLOCATE` sentinel
 *        for public-connectivity NAT gateways so resource_provisioner
 *        allocates a real EIP at apply time — never at plan time (leaks
 *        $3.60/mo if user runs `plan` but never `apply`).
 *
 *   2. `postRepairPostProcess` — runs AFTER `repairRequiredFields`:
 *      - EC2 instance post-processing: drops invalid SG IDs (non-`sg-`
 *        prefix) and injects an SSH key-pair placeholder when the user
 *        intent mentions `ssh` but the LLM (and repair) omitted `KeyName`.
 *
 * TODO (Epic 53 it2 — plugin `postProcessPlan` migration): lift these
 * resource-type-specific branches into their owning plugins. See
 * `feedback_long_lists_ux.md` + Epic 53 iteration-2 scope. This story
 * (Epic 53 it1) only extracts the logic into a sibling module; plugin-hook
 * migration is deferred.
 *
 * SRP: one reason to change — per-resource-type post-processing rules.
 */
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  AwsDefault,
} from "@/index.js";
import { resolveAmiFromOsName } from "@/utils/aws-resource-discovery/index.js";
import { assertSshIntentNotWindowsAmi } from "../ssh-windows-guard.js";
import type { AgentState } from "@/graph/graph-state.js";

export interface PostProcessOk {
  kind: "ok";
  desiredState: Record<string, unknown>;
}

export interface PostProcessShortCircuit {
  kind: "short-circuit";
  state: Partial<AgentState>;
}

export type PostProcessResult = PostProcessOk | PostProcessShortCircuit;

/**
 * Pre-repair branch: EC2 AMI resolution + NAT EIP placeholder. Runs BEFORE
 * `repairRequiredFields` so that a present (but unresolved) OS name gets
 * resolved, while a missing ImageId is left for repair to fill with a
 * plugin default (which is subsequently NOT resolved — pre-refactor
 * behaviour preserved bit-for-bit).
 */
export async function preRepairPostProcess(
  desiredState: Record<string, unknown>,
  state: AgentState,
): Promise<PostProcessResult> {
  if (state.resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    const amiResult = await resolveEc2Ami(desiredState);
    if (amiResult.kind === "short-circuit") return amiResult;
    desiredState = amiResult.desiredState;
  }

  // Story E2E.5: NatGateway with public connectivity requires an EIP
  // AllocationId placeholder; resource_provisioner resolves it at apply
  // time. Never allocate a real EIP during plan — `plan` without `apply`
  // would leak $3.60/mo.
  if (state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY) {
    populateNatEipPlaceholder(desiredState);
  }

  return { kind: "ok", desiredState };
}

/**
 * Post-repair branch: EC2 SG cleanup + SSH key-pair injection. Runs AFTER
 * `repairRequiredFields` so the SSH injection can see a KeyName that
 * repair would have filled (and therefore NOT override it).
 *
 * Async since SSH-intent flows now perform a (cached) DescribeImages
 * lookup via `assertSshIntentNotWindowsAmi` — see the shared
 * `ssh-windows-guard.ts` module — to fail-fast before injecting the
 * KeyName placeholder when the AMI is Windows.
 */
export async function postRepairPostProcess(
  desiredState: Record<string, unknown>,
  state: AgentState,
): Promise<Record<string, unknown>> {
  if (state.resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    await postProcessEc2Instance(desiredState, state.userIntent ?? "");
  }
  return desiredState;
}

/** EC2 AMI resolution — unchanged behaviour; short-circuits on miss. */
async function resolveEc2Ami(
  desiredState: Record<string, unknown>,
): Promise<PostProcessResult> {
  const raw = desiredState[CfnKey.IMAGE_ID];
  if (typeof raw !== "string" || raw.startsWith("ami-")) {
    return { kind: "ok", desiredState };
  }

  const osName = raw;
  const resolvedAmi = await resolveAmiFromOsName(osName);
  if (resolvedAmi) {
    desiredState[CfnKey.IMAGE_ID] = resolvedAmi;
    return { kind: "ok", desiredState };
  }
  return {
    kind: "short-circuit",
    state: {
      desiredState: {},
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Cannot resolve "${osName}" to a real AMI ID. Please either:\n  1. Run "aws sso login" to refresh credentials, then retry\n  2. Use "Other" in the AMI field and enter a real AMI ID (e.g., ami-0c55b159cbfafe1f0)`,
    },
  };
}

/**
 * Inserts the EIP_AUTO_ALLOCATE sentinel into a NAT-gateway desired state
 * when connectivity is public (or unset — AWS default is public) and no
 * AllocationId was provided.
 */
function populateNatEipPlaceholder(
  desiredState: Record<string, unknown>,
): void {
  const isPublic =
    desiredState[CfnKey.CONNECTIVITY_TYPE] === AwsDefault.CONNECTIVITY_PUBLIC ||
    !desiredState[CfnKey.CONNECTIVITY_TYPE];
  if (!isPublic) return;

  const needsPlaceholder =
    !desiredState[CfnKey.ALLOCATION_ID] ||
    desiredState[CfnKey.ALLOCATION_ID] === EIP_AUTO_ALLOCATE;
  if (!needsPlaceholder) return;

  desiredState[CfnKey.ALLOCATION_ID] = EIP_AUTO_ALLOCATE;
}

/**
 * Cleans up LLM artifacts for EC2 instances:
 *   - Drops SG IDs that are not real `sg-...` values (and removes the list
 *     entirely when every entry was bogus — CloudControl rejects empty arrays).
 *   - Injects an SSH key-pair placeholder when the user intent mentions `ssh`
 *     but the LLM omitted `KeyName` — gated behind the shared SSH-on-Windows
 *     fail-fast (`assertSshIntentNotWindowsAmi`) so a Windows AMI + SSH
 *     intent throws `AssigneeError(WINDOWS_SSH_INCOMPATIBLE)` BEFORE the
 *     placeholder lands. Mirrors the compound-path guard in
 *     `compound-helpers.ts:postProcessEc2Compound`.
 */
async function postProcessEc2Instance(
  desiredState: Record<string, unknown>,
  userIntent: string,
): Promise<void> {
  const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
  if (Array.isArray(sgIds)) {
    const valid = (sgIds as string[]).filter(
      (id) => typeof id === "string" && id.startsWith("sg-"),
    );
    if (valid.length === 0) {
      delete desiredState[CfnKey.SECURITY_GROUP_IDS];
    } else {
      desiredState[CfnKey.SECURITY_GROUP_IDS] = valid;
    }
  }

  if (userIntent && /\bssh\b/i.test(userIntent)) {
    // Fail-fast on Windows AMI BEFORE we inject the SSH key placeholder
    // — we want the user to see the actionable error, not waste time
    // wiring a keypair that will be useless on a Windows box.
    await assertSshIntentNotWindowsAmi(desiredState, userIntent);
    if (!desiredState[CfnKey.KEY_NAME]) {
      desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
    }
  }
}
