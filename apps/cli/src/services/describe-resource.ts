/**
 * SSH-bundle Story iv — `assignee admin describe` service helper.
 *
 * Composes a `RenderableState` for a previously-applied resource, given
 * either a runId (UUID-shaped) or a full resource ARN. The composition
 * is two-step:
 *
 *   1. Look up the apply-time provision record via
 *      `MemoryService.readProvisionRecord(runIdOrArn)`. The polymorphism
 *      lives in the memory service helper (partition-aware ARN regex
 *      `/^arn:aws[\w-]*:/` — see `feedback_partition_aware_arn_matching`).
 *      Not-found → throw a friendly `DescribeNotFoundError` so the
 *      command can route through `renderError` without bleeding stack
 *      frames into stderr.
 *
 *   2. For EC2 instances, issue a live `DescribeInstances` against the
 *      same operator credentials `apply-single.ts` used at apply time
 *      (matches the existing post-apply DescribeInstances in
 *      `formatApplySingleSuccess`). No caching — DescribeInstances is
 *      uncharged by AWS and tolerant of one-call-per-CLI-invocation
 *      load, AND the spec's primary verification scenario (user runs
 *      describe → stops/starts EC2 → IP changes → user re-runs describe)
 *      requires a fresh fetch each invocation.
 *
 *      When the live PublicIpAddress differs from
 *      `provision.publicIpAddressAtApply`, the result carries the
 *      apply-time IP separately (`apply.publicIpAddressAtApply`) so the
 *      command can render `(was <old-ip> at apply time)` as a styled
 *      annotation line right after `renderApplySuccess` returns. The
 *      apply-success renderer itself stays Story-ii/iii-owned and
 *      unchanged — no `RenderableState` extension needed.
 *
 * Non-EC2 resources skip the live fetch entirely (RDS / Lambda / S3 /
 * IAM have no PublicIpAddress concept) — the renderable state is built
 * from the provision record alone.
 *
 * The caller (the `describe` command) hands the resulting state to
 * `renderApplySuccess` for byte-identical re-rendering. NO duplicated
 * rendering logic lives in this file.
 *
 * Credential pick: `tryAssigneeCredentials("operator")`. Justification:
 *   - `apply-single.ts` (Story ii) calls DescribeInstances with
 *     `requireAssigneeCredentials("operator")` — the apply-time write
 *     side. `assignee admin describe` is the read side of that same wire.
 *   - `apps/cli/src/services/list-resources.ts` (the closest sibling
 *     CLI service for "look up an existing resource") also uses
 *     `tryAssigneeCredentials("operator")`. We match that file rather
 *     than `status.ts` because status delegates to `list-resources.ts`
 *     for the actual SDK call — the operator role IS what status
 *     transitively uses. Auditor would also be reasonable for a
 *     read-only command, but staying with operator means no third
 *     credential path is invented (per the spec's explicit ban) AND
 *     a user who already authenticated for `apply` doesn't need to
 *     mint a separate auditor credential before running `describe`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DescribeInstancesCommand, type Instance } from "@aws-sdk/client-ec2";
import {
  AssigneeError,
  ASSIGNEE_DIR,
  type RenderableState,
  type ProvisionRecord,
  defaultMemoryService,
  RESOURCE_TYPES,
  createEC2Client,
  tryGetAmiDefaultUser,
} from "@assignee/core";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import { AWS_REGION } from "../config/constants.js";

/**
 * Whitelist sanitizer for SSH keypair filenames. Re-implemented here to
 * avoid widening the `@assignee/core` public surface for one call site;
 * the canonical implementation lives at
 * `packages/core/src/graph/nodes/resource-provisioner/util.ts:sanitizeKeyName`
 * and any change there must be mirrored here. Identity on the SSH-bundle
 * placeholder (`assignee-ssh-key`); only meaningful when a future call
 * site surfaces a user-supplied KeyName containing path separators or
 * shell metacharacters.
 */
function sanitizeKeyNameForDescribe(name: string): string {
  let cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  while (cleaned.length > 0 && (cleaned[0] === "." || cleaned[0] === "_")) {
    cleaned = cleaned.slice(1);
  }
  return cleaned.length === 0 ? "assignee_key" : cleaned;
}

/**
 * Pre-demo audit (2026-05-05): mirror the apply-single.ts existsSync gate
 * so `assignee admin describe` does NOT render a Connect line pointing to a
 * `.pem` that doesn't exist on this box (cross-machine describe scenario).
 * The renderer's `if (!keyName) return;` guard then silently suppresses
 * the Connect line, matching apply-time semantics.
 *
 * Returns the sanitized key name only when the on-disk file is present;
 * otherwise undefined → renderer suppresses.
 */
function readKeyNameIfPemPresent(rawKeyName: string): string | undefined {
  const safe = sanitizeKeyNameForDescribe(rawKeyName);
  const keyPath = join(homedir(), ASSIGNEE_DIR, "keys", `${safe}.pem`);
  return existsSync(keyPath) ? safe : undefined;
}

/**
 * Error thrown when no provision record matches the supplied
 * `runIdOrArn`. Carries `alreadyRendered=false` initially so the
 * command layer can print the user-friendly triple via `renderError`
 * and then re-throw with the flag set (matches the convention in
 * list.ts / status.ts).
 */
export class DescribeNotFoundError extends AssigneeError {
  constructor(public readonly input: string) {
    super(`No provision record found for "${input}".`, "DESCRIBE_NOT_FOUND");
    this.name = "DescribeNotFoundError";
  }
}

/**
 * Fetch a live EC2 Instance via DescribeInstances. Returns `undefined`
 * on any failure (throttle / AccessDenied / network) or when no
 * matching instance is found — the caller falls back to provision-
 * record-only rendering.
 *
 * No caching — every `assignee admin describe` invocation issues a fresh
 * DescribeInstances call. DescribeInstances is uncharged by AWS, and
 * the primary verification scenario (stop/start cycle reissues the
 * public IP, user re-runs `describe` to see the new IP) MUST observe
 * the new IP rather than a stale per-process cache value.
 */
async function fetchLiveInstance(
  instanceId: string,
): Promise<Instance | undefined> {
  const creds = tryAssigneeCredentials("operator");
  if (!creds) return undefined;

  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    ec2 = createEC2Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      },
    });
    const out = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const instance = out.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;
    return instance;
  } catch {
    // Live fetch is best-effort — fall back to provision-record-only
    // rendering. The apply-time public IP (if any) is still surfaced
    // via the `publicIpAddressAtApply` field below.
    return undefined;
  } finally {
    ec2?.destroy();
  }
}

/**
 * Extract the bare InstanceId from `provision.resourceArn` for an EC2
 * instance. The provision record stores the full ARN
 * (`arn:aws:ec2:us-east-1:123456789012:instance/i-…`); DescribeInstances
 * needs just the bare InstanceId. Falls back to the raw arn value if
 * the regex misses (defensive — pre-Story-iv records may have stored
 * the bare id directly during a transitional window).
 */
function extractInstanceId(resourceArn: string): string {
  const match = resourceArn.match(/instance\/(i-[0-9a-f]+)$/);
  return match?.[1] ?? resourceArn;
}

/**
 * Output type — the `RenderableState` for the resource plus a flag
 * indicating whether the live fetch succeeded (used by `--json` mode
 * to surface a `liveFetch: false` envelope when AWS was unreachable),
 * and the apply-time public IP for the divergence annotation.
 */
export interface DescribeResult {
  state: RenderableState;
  /** Display ARN (resolved). Same value passed to renderApplySuccess. */
  displayArn: string;
  /** Apply-time provision record (raw, for JSON mode). */
  provision: ProvisionRecord;
  /** True when DescribeInstances was attempted (EC2 only). */
  liveFetchAttempted: boolean;
  /** True when DescribeInstances returned a matching instance. */
  liveFetchSucceeded: boolean;
  /**
   * The apply-time PublicIpAddress, surfaced separately ONLY when it
   * differs from the live `state.publicIpAddress`. The describe command
   * uses this to render an inline `(was <old-ip> at apply time)`
   * annotation as a styled stdout line directly after
   * `renderApplySuccess` returns. Undefined when (a) no apply-time IP
   * was recorded, (b) the live IP equals the apply-time IP, or (c) the
   * live fetch failed and we fell back to the apply-time IP as the
   * primary display value.
   */
  publicIpAddressAtApplyForAnnotation?: string;
}

/**
 * Build a renderable description of a previously-applied resource.
 *
 * Polymorphism:
 *   - `runIdOrArn` matching `/^arn:aws[\w-]*:/` → ARN lookup.
 *   - Anything else → runId lookup.
 *
 * Throws `DescribeNotFoundError` when no provision record matches.
 *
 * The returned `state.publicIpAddress` is the LIVE value (when the
 * resource is EC2 and the live fetch succeeded). The
 * `state.publicIpAddressAtApply` field carries the apply-time snapshot
 * if it was recorded AND differs from the live value — the renderer
 * uses this divergence to append `(was X at apply time)`. When the
 * live IP equals the apply-time IP, `publicIpAddressAtApply` is left
 * undefined so the renderer prints just the IP without the redundant
 * annotation.
 */
export async function describeResource(
  runIdOrArn: string,
): Promise<DescribeResult> {
  const provision = await defaultMemoryService.readProvisionRecord(runIdOrArn);
  if (!provision) {
    throw new DescribeNotFoundError(runIdOrArn);
  }

  // Base renderable state from the provision record alone — no live
  // fetch yet. This is the "fast path" for non-EC2 resources and the
  // fallback for EC2 when the live fetch fails.
  const state: RenderableState = {
    runId: provision.runId,
    resourceType: provision.resourceType,
    resourceArn: provision.resourceArn,
    estimatedMonthlyCost: provision.estimatedMonthlyCost,
  };

  const result: DescribeResult = {
    state,
    displayArn: provision.resourceArn,
    provision,
    liveFetchAttempted: false,
    liveFetchSucceeded: false,
  };

  // Non-EC2 fast path: no DescribeInstances, no AMI lookup.
  if (provision.resourceType !== RESOURCE_TYPES.EC2_INSTANCE) {
    return result;
  }

  result.liveFetchAttempted = true;
  const instanceId = extractInstanceId(provision.resourceArn);
  const live = await fetchLiveInstance(instanceId);
  if (!live) {
    // Surface the apply-time IP at minimum so the user sees something
    // useful even when AWS is unreachable.
    if (provision.publicIpAddressAtApply) {
      state.publicIpAddress = provision.publicIpAddressAtApply;
    }
    return result;
  }

  result.liveFetchSucceeded = true;

  if (live.PublicIpAddress) {
    state.publicIpAddress = live.PublicIpAddress;
  }
  if (live.PublicDnsName) {
    state.publicDnsName = live.PublicDnsName;
  }

  // Divergence annotation: only set the result-level apply-time IP
  // when (a) we recorded an apply-time IP, AND (b) it differs from the
  // live value. Equal IPs collapse to a single line (no redundant
  // `(was 1.2.3.4 at apply time)` when the apply-time IP matches the
  // current one). The annotation is rendered by the describe command
  // as an additive stdout line right after renderApplySuccess returns,
  // keeping `apply-success.ts` (Story ii/iii territory) unchanged.
  if (
    state.publicIpAddress &&
    provision.publicIpAddressAtApply &&
    provision.publicIpAddressAtApply.length > 0 &&
    provision.publicIpAddressAtApply !== state.publicIpAddress
  ) {
    result.publicIpAddressAtApplyForAnnotation =
      provision.publicIpAddressAtApply;
  }

  // SSH connect line — gated on KeyName + AMI default user, mirroring
  // apply-single.ts. The KeyName comes off the live Instance (apply
  // time KeyName was persisted to AWS as `Instance.KeyName`); the AMI
  // default user is resolved via the same DescribeImages helper Story
  // iii used.
  //
  // Pre-demo audit (2026-05-05): also mirror apply-single.ts's
  // existsSync gate so the Connect line is suppressed silently when the
  // local `.pem` is missing (cross-machine describe scenario). Without
  // this, describe would render a Connect line pointing to a file the
  // user can't actually use.
  if (live.KeyName) {
    const presentKeyName = readKeyNameIfPemPresent(live.KeyName);
    if (presentKeyName) {
      state.keyName = presentKeyName;
    }
  }
  if (live.ImageId) {
    state.amiId = live.ImageId;
    const sshUsername = await tryGetAmiDefaultUser(
      live.ImageId,
      provision.runId,
    );
    if (sshUsername) {
      state.sshUsername = sshUsername;
    }
  }

  return result;
}
