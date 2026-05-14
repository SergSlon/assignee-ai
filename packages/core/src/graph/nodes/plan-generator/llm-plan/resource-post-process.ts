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
 *      - S3 bucket-name hallucination guard (EPIC-106-7 / PH5-8-B): when
 *        the LLM proposes a BucketName and the name was NOT set by the
 *        intent-parser (neither "named X" keyword nor inline-name extractor
 *        fired), replace it with a deterministic `assignee-s3-bucket-<8hex>`
 *        to avoid silent hallucinated names landing in real AWS accounts.
 *      - Same guard for Lambda FunctionName and SQS QueueName which have no
 *        plugin-level toCfn guard in the LLM path.
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
import { isSshIntent } from "@/utils/ssh-intent.js";
import type { AgentState } from "@/graph/graph-state.js";
import { injectMasterPasswordPlaceholderIfAbsent } from "@/resource-plugins/plugins/rds-dbinstance/credentials.js";

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

  // RG-1 / DF-E5 (Solution C): inject the actionable placeholder when
  // MasterUserPassword was not supplied by the user so the plan is never
  // silently missing this required field. Preflight-guard rejects apply
  // if the placeholder sentinel is still present at that stage.
  if (state.resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    injectMasterPasswordPlaceholderIfAbsent(
      desiredState,
      state.elicitedOptions,
    );
  }

  // EPIC-106-7 / PH5-8-B: deterministic name guards for resource types where
  // the LLM can silently hallucinate a name when the user never supplied one.
  // Only replaces the name when the intent-parser did NOT extract a user-
  // provided name (i.e., neither "named X" keyword nor inline-name extractor
  // fired). User-provided names are preserved.
  guardLlmHallucinatedName(
    desiredState,
    state.elicitedOptions,
    state.resourceType ?? "",
    state.runId ?? "",
  );

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

  if (isSshIntent(userIntent)) {
    // Fail-fast on Windows AMI BEFORE we inject the SSH key placeholder
    // — we want the user to see the actionable error, not waste time
    // wiring a keypair that will be useless on a Windows box.
    await assertSshIntentNotWindowsAmi(desiredState, userIntent);
    if (!desiredState[CfnKey.KEY_NAME]) {
      desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
    }
  }
}

// ---------------------------------------------------------------------------
// EPIC-106-7 / PH5-8-B — LLM name-hallucination guard
// ---------------------------------------------------------------------------
//
// Resource types with a user-settable name field: when the LLM proposes a
// name AND the intent-parser did NOT extract a user-provided name (i.e.
// neither the "named X" keyword path nor the inline-name extractor fired),
// the LLM name is silently wrong. Replace it with a deterministic
// `assignee-<type>-<8hex>` to prevent hallucinated names reaching AWS.
//
// Guard logic: the intent-parser writes its result into `elicitedOptions`
// (which `mergeElicitedOptions` then spreads on top of the LLM output).
// So if the name field is absent from `elicitedOptions`, the name currently
// in `desiredState` came entirely from the LLM and must be replaced.

/**
 * Per-resource-type: CFN name-field → deterministic `assignee-…` prefix.
 * Covers S3, Lambda (standalone/LLM path), and SQS — DynamoDB, SNS, and ECR
 * already have toCfn guards in their plugin files and do not need this shim.
 */
const NAME_HALLUCINATION_GUARD: ReadonlyArray<{
  resourceType: string;
  nameField: string;
  prefix: string;
}> = [
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    nameField: CfnKey.BUCKET_NAME,
    prefix: "assignee-s3-bucket",
  },
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    nameField: CfnKey.FUNCTION_NAME,
    prefix: "assignee-lambda-fn",
  },
  {
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
    nameField: CfnKey.QUEUE_NAME,
    prefix: "assignee-sqs-queue",
  },
];

function generateDeterministicName(prefix: string, runId: string): string {
  return `${prefix}-${runId.slice(0, 8)}`;
}

/**
 * Replaces an LLM-hallucinated resource name with a deterministic
 * `assignee-<type>-<runId[:8]>` identifier when the user never provided a name.
 *
 * Uses the first 8 characters of `runId` (same convention as
 * `injectCompoundResourceName` in compound-helpers.ts) so the same intent
 * always produces the same name within a run, preserving plan→apply
 * idempotency.
 *
 * Safe to call for every resource type — the `NAME_HALLUCINATION_GUARD`
 * table acts as an allowlist; types not listed are untouched.
 */
function guardLlmHallucinatedName(
  desiredState: Record<string, unknown>,
  elicitedOptions: AgentState["elicitedOptions"],
  resourceType: string,
  runId: string,
): void {
  const guard = NAME_HALLUCINATION_GUARD.find(
    (g) => g.resourceType === resourceType,
  );
  if (!guard) return;

  const { nameField, prefix } = guard;

  // If the intent-parser captured a user-provided name it will be present
  // in elicitedOptions. In that case the name in desiredState is authoritative
  // (it was written by mergeElicitedOptions) — preserve it.
  if (
    elicitedOptions &&
    typeof elicitedOptions[nameField] === "string" &&
    (elicitedOptions[nameField] as string).length > 0
  ) {
    return;
  }

  // LLM proposed a name (or repair injected one). Replace unconditionally.
  if (typeof desiredState[nameField] === "string") {
    desiredState[nameField] = generateDeterministicName(prefix, runId);
  }
}
