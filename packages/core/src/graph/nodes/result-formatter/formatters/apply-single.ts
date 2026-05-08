/**
 * Single-resource apply SUCCESS formatter.
 *
 * Display/log/billing use the resolved full ARN; graph state.resourceArn stays
 * as the bare CCAPI identifier UNLESS resolution transformed it (SSM Parameter
 * case — see the lengthy rationale in the original result-formatter.ts). The
 * partial-state return respects the legacy `expect(result).toEqual({})`
 * assertions in result-formatter.test.ts.
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StructuredTool } from "@langchain/core/tools";
import { RESOURCE_TYPES, CfnKey } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { renderApplySuccess } from "@/utils/display.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { checkSecurityPosture } from "@/utils/security-posture.js";
import {
  writeProvisionRecord,
  clearFailureHistory,
} from "@/utils/memory-recorder.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { ASSIGNEE_DIR } from "@/config/constants/paths.js";
import { requireAssigneeCredentials } from "@/config/aws-credentials.js";
import { createEC2Client } from "@/aws/ec2-client-factory.js";
import { tryGetAmiDefaultUser } from "@/utils/aws-resource-discovery/ami-default-user.js";
import { sanitizeKeyName } from "@/graph/nodes/resource-provisioner/util.js";
import { getOperatorCallerArn } from "@/utils/resolve-arn.js";
import { attachCompensatingBucketPolicy } from "@/services/s3-compensating-bucket-policy.js";
import { resolveDisplayArn } from "../arn-display.js";
import { runStaticSiteUploadFor } from "./static-site-upload.js";

/**
 * SSH-bundle Story ii — post-apply DescribeInstances. After a CCAPI
 * EC2::Instance create succeeds the bare identifier in
 * `state.resourceArn` is the InstanceId (e.g. `i-0abc123def4567890`);
 * call DescribeInstances against the operator credentials (mirrors
 * every other apply-time EC2 SDK call: `ssh-keypair.ts`, `subnet.ts`,
 * `eip-allocator.ts`, `cleanup.ts`) and pull `PublicIpAddress` /
 * `PublicDnsName` from the first matched instance. Wrapped in
 * try/catch so a DescribeInstances failure (throttle, AccessDenied,
 * network) silently degrades the apply-success line back to ARN-only;
 * the apply itself stays successful.
 *
 * Story iii extension: also returns the `ImageId` (resolved AMI ID)
 * from the same describe response so the caller can resolve the
 * AMI's default SSH user via `getAmiDefaultUser` for the Connect-line
 * render — saves a second SDK round-trip at apply time.
 *
 * Returns `{ publicIpAddress?, publicDnsName?, amiId? }` — empty
 * object on any failure or when the instance has no public network
 * exposure.
 */
async function fetchEc2PublicNetwork(
  instanceId: string,
  runId: string,
): Promise<{
  publicIpAddress?: string;
  publicDnsName?: string;
  amiId?: string;
}> {
  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    const { DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    ec2 = createEC2Client({
      region: AWS_REGION,
      credentials: requireAssigneeCredentials("operator"),
    });
    const out = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const instance = out.Reservations?.[0]?.Instances?.[0];
    if (!instance) return {};
    const result: {
      publicIpAddress?: string;
      publicDnsName?: string;
      amiId?: string;
    } = {};
    if (instance.PublicIpAddress) {
      result.publicIpAddress = instance.PublicIpAddress;
    }
    if (instance.PublicDnsName) {
      result.publicDnsName = instance.PublicDnsName;
    }
    if (instance.ImageId) {
      result.amiId = instance.ImageId;
    }
    return result;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.APPLY_SUCCEEDED,
      extras: { describeInstancesSkipped: errMsg, instanceId },
    });
    return {};
  } finally {
    ec2?.destroy();
  }
}

/**
 * SSH-bundle Story iii — derive the `keyName` overlay marker.
 *
 * The SSH bundle in `compound-helpers.ts` (and the LLM-plan
 * `resource-post-process.ts` mirror) injects
 * `state.desiredState[KeyName]` whenever the user intent matches
 * `/\bssh\b/i`. Apply-time the keypair is created under
 * `~/.assignee/keys/<sanitized>.pem` (see
 * `resource-provisioner/ssh-keypair.ts`). When the desired state
 * carries a string KeyName, we surface it on the RenderableState so
 * the apply-success renderer can build a copy-pasteable
 * `ssh -i ~/.assignee/keys/<sanitized>.pem ...` line.
 *
 * Two defensive guards live here so the renderer can stay type-
 * agnostic / no-I/O:
 *
 *   1. **Sanitisation (MED #4)** — we apply `sanitizeKeyName` to the
 *      raw value so the printed command's filename matches the
 *      on-disk keypair file (which `ssh-keypair.ts` always sanitises
 *      before writing). Without this, an LLM- or user-seeded
 *      `KeyName: "my key;rm -rf"` would (a) print a filename that
 *      does not exist on disk and (b) be shell-injectable when
 *      copy-pasted.
 *
 *   2. **File-existence (HIGH #2)** — the spec invariant
 *      ("Connect: line is suppressed silently if the keypair file
 *      does NOT exist on disk") means we must verify the .pem is
 *      present before surfacing the keyName. The renderer then
 *      naturally suppresses the Connect line via its existing
 *      `if (!keyName) return;` gate.
 *
 * Returns `undefined` when there is no SSH-bundle marker, the value
 * is non-string / empty, OR the corresponding .pem file is missing.
 */
function readKeyNameFromDesired(
  desiredState: Record<string, unknown> | undefined,
): string | undefined {
  if (!desiredState) return undefined;
  const raw = desiredState[CfnKey.KEY_NAME];
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const safeKeyName = sanitizeKeyName(raw);
  const keyPath = join(homedir(), ASSIGNEE_DIR, "keys", `${safeKeyName}.pem`);
  if (!existsSync(keyPath)) return undefined;
  return safeKeyName;
}

export async function formatApplySingleSuccess(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  const displayArn = await resolveDisplayArn(
    state.resourceType,
    state.resourceArn,
  );

  // SSH-bundle Story ii: enrich the renderable state with public IP /
  // public DNS for EC2 instances ONLY. Other types skip the
  // describe call entirely (RDS / Lambda / S3 / etc. have no
  // PublicIpAddress concept and the call would be wasted). The
  // returned object is spread onto state at the renderer boundary
  // so the LangGraph reducer never sees these display-only fields —
  // they are not first-class graph state.
  //
  // Story iii: when the SSH bundle marked this EC2 with a KeyName, also
  // resolve the AMI's default SSH user so the renderer can build the
  // Connect line. The AMI ID comes from the same DescribeInstances
  // response (no extra round-trip on the happy path) — fall back to
  // `state.desiredState[ImageId]` if the response was missing the
  // field for some reason.
  let networkOverlay:
    | {
        publicIpAddress?: string;
        publicDnsName?: string;
        amiId?: string;
        keyName?: string;
        sshUsername?: string;
      }
    | undefined;
  if (state.resourceType === RESOURCE_TYPES.EC2_INSTANCE && state.resourceArn) {
    const describeOverlay = await fetchEc2PublicNetwork(
      state.resourceArn,
      state.runId,
    );
    networkOverlay = { ...describeOverlay };

    const keyName = readKeyNameFromDesired(state.desiredState);
    if (keyName) {
      networkOverlay.keyName = keyName;
      // Prefer the ImageId from describe; fall back to the resolved
      // value already in desiredState.
      const desiredImageId = state.desiredState?.[CfnKey.IMAGE_ID];
      const amiId =
        describeOverlay.amiId ??
        (typeof desiredImageId === "string" && desiredImageId.startsWith("ami-")
          ? desiredImageId
          : undefined);
      if (amiId) {
        networkOverlay.amiId = amiId;
        const sshUsername = await tryGetAmiDefaultUser(amiId, state.runId);
        if (sshUsername) {
          networkOverlay.sshUsername = sshUsername;
        }
      }
    }
  }

  renderApplySuccess(
    networkOverlay ? { ...state, ...networkOverlay } : state,
    displayArn,
  );
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_SUCCEEDED,
    extras: { resourceArn: displayArn },
  });

  // Bug S3-001 Part 2 — compensating bucket policy for tag-scoped destructive
  // access. AWS does NOT auto-populate `aws:ResourceTag` for S3 bucket-level
  // IAM evaluations (DeleteBucket / DeleteBucketPolicy), so the identity-policy
  // `S3BucketDestructiveResourcePrefixScoped` statement grants those actions
  // unscoped. Attaching a resource-based bucket policy here restores per-bucket
  // tag scoping at the bucket-policy enforcement layer.
  //
  // Non-blocking: if PutBucketPolicy fails (throttle, IAM gap), warn loudly
  // but do NOT roll back the bucket creation — the bucket exists and the user
  // can re-run `assignee setup` to re-attach. The identity policy already
  // allows destructive operations so the bucket is fully functional.
  // bug-s3-bucket-policy-attach-failure-observability: capture the
  // attach outcome so it can be persisted on the provision record below.
  // Undefined for non-S3 resources or when the operator ARN was
  // unavailable (skip path) — `writeProvisionRecord` then omits the
  // field from the JSON entirely.
  let compensatingPolicyAttached: boolean | undefined;
  let compensatingPolicyError: string | undefined;
  if (state.resourceType === RESOURCE_TYPES.S3_BUCKET && state.resourceArn) {
    const operatorArn = await getOperatorCallerArn();
    if (operatorArn) {
      const policyResult = await attachCompensatingBucketPolicy({
        bucketName: state.resourceArn,
        operatorArn,
        region: AWS_REGION,
      });
      compensatingPolicyAttached = policyResult.attached;
      if (!policyResult.attached) {
        compensatingPolicyError = policyResult.reason ?? "unknown error";
        process.stderr.write(
          chalk.yellow(
            `⚠ Compensating bucket policy could not be attached to ${state.resourceArn}: ${policyResult.reason ?? "unknown error"}\n` +
              `  The bucket was created successfully but per-bucket tag-scoped destructive access is NOT in effect.\n` +
              `  Re-run \`assignee setup\` to retry the policy attachment.\n`,
          ),
        );
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: {
            compensatingBucketPolicyFailed: true,
            bucketName: state.resourceArn,
            reason: policyResult.reason,
          },
        });
      }
    } else {
      // Operator ARN unavailable (STS not yet called, or preflight skipped).
      // Log but do not block the apply — the bucket creation already succeeded.
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: {
          compensatingBucketPolicySkipped: true,
          bucketName: state.resourceArn,
          reason: "operator ARN unavailable — STS not called yet",
        },
      });
    }
  }

  // Story 37.4 — static-site upload when --source is set and the resource is S3.
  if (
    state.sourceDir &&
    state.resourceType === RESOURCE_TYPES.S3_BUCKET &&
    state.resourceArn
  ) {
    await runStaticSiteUploadFor(state.resourceArn, state.sourceDir);
  }

  if (state.sourceDir && state.resourceType !== RESOURCE_TYPES.S3_BUCKET) {
    process.stderr.write(
      chalk.yellow(
        `⚠ --source flag ignored: file upload only supported for S3 buckets, not ${state.resourceType}\n`,
      ),
    );
  }

  // Story 19.3 — provision record uses the full ARN so billing lookups work.
  // SSH-bundle Story iv: capture the apply-time PublicIpAddress (when the
  // post-apply DescribeInstances overlay produced one) so `assignee
  // describe` can render `(was X at apply time)` if the live IP later
  // diverges (stop/start cycles re-issue public IPs). Undefined-by-
  // default extras keep behaviour byte-identical for non-EC2 / private-
  // subnet resources.
  // bug-s3-bucket-policy-attach-failure-observability: thread the
  // S3 compensating-policy outcome (captured above) onto the
  // provision record so `assignee list` can flag buckets where the
  // per-bucket tag boundary is not in effect.
  const recordExtras: Parameters<typeof writeProvisionRecord>[6] = {
    ...(networkOverlay?.publicIpAddress
      ? { publicIpAddressAtApply: networkOverlay.publicIpAddress }
      : {}),
    ...(compensatingPolicyAttached !== undefined
      ? { compensatingPolicyAttached }
      : {}),
    ...(compensatingPolicyError ? { compensatingPolicyError } : {}),
  };
  await writeProvisionRecord(
    state.runId,
    state.resourceType,
    displayArn,
    state.desiredState,
    state.estimatedMonthlyCost,
    undefined,
    Object.keys(recordExtras).length > 0 ? recordExtras : undefined,
  );

  // Story 20.13 — wipe stale failure history for this resource type.
  await clearFailureHistory(state.runId, state.resourceType);

  // Story 19.2 — security posture check (non-blocking).
  if (displayArn && tools) {
    await checkSecurityPosture(displayArn, tools, state.runId);
  }

  // 2026-04-11 fix: propagate the full ARN into final state ONLY when the
  // resolver actually transformed the identifier (e.g. SSM parameter name
  // "/app/env/key" → "arn:aws:ssm:...:parameter/app/env/key"). See the
  // detailed commentary in result-formatter.ts for why we can't return
  // {resourceArn: displayArn} unconditionally — the compound marker
  // resolver feeds state.resourceArn verbatim into child VpcId/SubnetId
  // fields that reject full ARNs.
  if (displayArn && displayArn !== state.resourceArn) {
    return { resourceArn: displayArn };
  }
  return {};
}
