/**
 * resource_provisioner node — State Guard (FR-15 Read-Before-Write) then CloudControl create.
 * Runs in Phase 2 of apply, after the LangGraph HITL interrupt is resumed.
 *
 * Depends on ProvisioningPort (DIP) — no direct AWS SDK imports.
 *
 * @see Story 7-6, Story 9-2
 */

import {
  ExecutionStatus,
  getPrimaryIdentifier,
  SUPPORTED_TYPES_ARRAY,
  RESOURCE_TYPES,
  PROVISIONING_ERROR_CODES,
  type ResourceType,
  ProvisioningError,
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
} from "@assignee/core";
import type { ProvisioningPort } from "../services/provisioning-port.js";
import { ProvisioningErrorKind } from "../services/provisioning-port.js";
import type { SDKFallbackDispatcher } from "../services/sdk-fallback-dispatcher.js";
import {
  injectMandatoryTags,
  TAG_KEY_MANAGED_BY,
  TAG_VALUE_MANAGED_BY,
} from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { AWS_REGION, ASSIGNEE_DIR } from "../config/constants.js";
import { requireAssigneeCredentials } from "../config/aws-credentials.js";
import type { AgentState } from "../services/graph-state.js";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}

/**
 * Format an unknown caught error for logging. Prefer the full stack trace
 * (for diagnosing EIP/SSH leaks and other transient AWS failures), fall back
 * to the message, and only stringify non-Error throws as a last resort.
 *
 * Exported for unit testing.
 */
export function formatErrorForLog(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

/**
 * Whitelist-based filename sanitizer for SSH key file names. Only
 * `[A-Za-z0-9._-]` survives — every other character (path separators, null
 * bytes, newlines, control chars, shell metacharacters, Unicode) is replaced
 * with `_`. A leading dot is also rejected so the resulting file is never
 * a hidden dotfile and never resolves to `.` or `..`. Empty results fall
 * back to a deterministic placeholder so we never write to `/.pem`.
 *
 * Exported for unit testing.
 */
export function sanitizeKeyName(name: string): string {
  let cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  // Strip leading dots and underscores so the result is never a hidden
  // dotfile, never resolves to "." or "..", and never starts with the
  // sanitization placeholder. We strip dots first (to handle ".." and
  // ".hidden") and underscores second (to handle the residue from path
  // separators that the regex above replaced — e.g. "../etc/passwd" →
  // "_etc_passwd" → "etc_passwd").
  while (cleaned.length > 0 && (cleaned[0] === "." || cleaned[0] === "_")) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.length === 0) {
    cleaned = "assignee_key";
  }
  return cleaned;
}

export async function resourceProvisionerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
  fallbackDispatcher?: SDKFallbackDispatcher,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

  // ── CloudFront S3 retry: wait for DNS propagation before re-creating ─────
  // When status_poller detects a transient S3 origin DNS failure, it clears
  // requestToken and increments retryCount, then the graph routes us back
  // here. We wait 30s to give S3 global DNS more propagation time before
  // attempting the createResource call again.
  const RETRY_DELAY_MS = 30_000;
  if (
    (state.retryCount ?? 0) > 0 &&
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    !state.requestToken
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        phase: "cloudfront_s3_retry_wait",
        retryCount: state.retryCount,
        delayMs: RETRY_DELAY_MS,
        message: `Waiting ${RETRY_DELAY_MS / 1000}s for S3 DNS propagation before retry ${state.retryCount}/3`,
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  // ── Skip non-provisionable resources (companion/post-provision) ──────────
  // Resources like CloudFront Distribution and OAC are created post-provision
  // via SDK, not through CloudControl. Mark them as SUCCESS and advance the loop.
  const currentResource =
    state.resourceQueue?.[state.currentResourceIndex ?? 0];
  if (currentResource?.provisionable === false) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
      extras: {
        resourceType: state.resourceType,
        dispatchPath: "companion-skip",
        message: `Skipping non-provisionable resource: ${currentResource.displayName}`,
      },
    });
    return {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: undefined,
    };
  }

  if (!state.desiredState) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Cannot provision: desiredState is missing.",
    };
  }

  // Item F: LangGraph nodes must not mutate input state in place. Work on a
  // DEEP clone of state.desiredState and return it via the reducer below.
  // The original state.desiredState reference is preserved unchanged.
  // H8: shallow clone (`{...state.desiredState}`) leaves nested objects like
  // Properties.Tags / Properties.PolicyDocument / Properties.UserData shared
  // with the original state, so `injectMandatoryTags` would mutate the
  // caller's nested arrays. Use `structuredClone` to fully isolate.
  const desiredState: Record<string, unknown> = structuredClone(
    state.desiredState,
  ) as Record<string, unknown>;

  // ── SDK Fallback Dispatch (Story 7.7) ────────────────────────────────────
  // Check for CCAPI gap types BEFORE the CloudControl path.
  if (state.resourceType && fallbackDispatcher) {
    // Check redirect types first (unsupported with known alternative)
    const redirect = fallbackDispatcher.isRedirect(state.resourceType);
    if (redirect) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
        extras: {
          resourceType: state.resourceType,
          dispatchPath: "redirect",
          message: redirect.message,
        },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: redirect.message,
        error: new ProvisioningError(
          redirect.message,
          PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE,
        ),
      };
    }

    // A10 (2026-04-09): no SDK-routable create types remain. The
    // dispatcher.canHandle() branch that used to route SNS
    // Subscription (and, before A6, Lambda EventSourceMapping) to
    // native SDK calls is retired — those types now flow through
    // the normal CCAPI path below via their first-class plugins.
    // The dispatcher survives only for isRedirect() above.
  }

  // ── State Guard (FR-15 Read-Before-Write) ────────────────────────────────
  if (!state.resourceType || !isResourceType(state.resourceType)) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Cannot provision: unsupported or missing resourceType "${state.resourceType ?? ""}".`,
    };
  }

  // S3 bucket names are globally unique across ALL AWS accounts. CloudControl
  // GetResource may return success for a bucket owned by a *different* account
  // (the name is reserved globally), causing a false "already exists" block.
  // Skip the state guard for S3 — the CreateResource call itself will correctly
  // return ALREADY_EXISTS if the name is genuinely taken.
  const skipStateGuard = state.resourceType === RESOURCE_TYPES.S3_BUCKET;

  const identifier = skipStateGuard
    ? undefined
    : getPrimaryIdentifier(state.resourceType, desiredState);

  // M-R4: For non-S3 types the state guard relies on a resolved primary
  // identifier. Compound resources whose identifier interpolates a parent
  // ARN (e.g. IAM RolePolicy = Role+PolicyName, EC2 Route = RouteTable+CIDR)
  // can produce `undefined` here when the parent isn't yet resolved at LLM
  // generation time. Silently skipping the guard lets a duplicate resource
  // sneak through. We log a warn-level audit event so operators can detect
  // it; provisioning still proceeds (the create call will surface
  // ALREADY_EXISTS if the resource genuinely exists).
  if (!skipStateGuard && !identifier) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.STATE_GUARD_SKIPPED_UNRESOLVED_IDENTIFIER,
      extras: {
        resourceType: state.resourceType,
        reason:
          "primary_identifier_unresolved (compound/composite identifier or unresolved parent ref)",
      },
    });
  }

  if (identifier) {
    const [stateGuardErr] = await provisioner.getResource(
      state.resourceType,
      identifier,
    );

    if (!stateGuardErr) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_ABORT,
        extras: { identifier, resourceType: state.resourceType },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Resource already exists (${identifier}). Choose a different name and re-run 'assignee plan'.`,
        error: new ProvisioningError(
          `Resource already exists (${identifier}). Choose a different name`,
          PROVISIONING_ERROR_CODES.STATE_MISMATCH,
        ),
      };
    }

    if (stateGuardErr.kind !== ProvisioningErrorKind.NOT_FOUND) {
      // Permission or identifier-format errors should not block CREATE — the resource
      // likely doesn't exist, we just can't verify. Log a warning and proceed.
      // This handles: ACCESS_DENIED, invalid identifier formats (SecretsManager Name vs ARN,
      // Route composite identifiers), and other transient GetResource failures.
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
        extras: { reason: stateGuardErr.kind, message: stateGuardErr.message },
      });
      // Fall through to proceed with creation
    }

    // NOT_FOUND = safe to proceed
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
      extras: { reason: "not_found" },
    });
  }

  // ── EIP allocation for NatGateway (deferred from plan_generator) ─────────
  // Plan generator sets AllocationId = EIP_AUTO_ALLOCATE as a placeholder
  // to avoid leaking EIPs when the user runs `plan` but never `apply`.
  // We resolve it here at apply time so the EIP is only allocated when actually needed.
  //
  // P0 FIX: On retry after a failed NAT Gateway provisioning, reuse any
  // previously-allocated EIP tagged with this runId instead of leaking a new one.
  //
  // C1: Track whether the EIP was allocated fresh in THIS invocation. The
  // failure-path cleanup must only release EIPs we just allocated — never
  // EIPs reused from a prior attempt, or the retry-reuse design is defeated.
  let eipAllocatedThisInvocation = false;
  if (
    state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
    desiredState[CfnKey.ALLOCATION_ID] === EIP_AUTO_ALLOCATE
  ) {
    try {
      const {
        EC2Client,
        AllocateAddressCommand,
        DescribeAddressesCommand,
        CreateTagsCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region: AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });

      // Check for an existing EIP allocated by a previous attempt for this runId
      let allocationId: string | undefined;
      try {
        const existing = await ec2.send(
          new DescribeAddressesCommand({
            Filters: [
              { Name: "tag:assignee:runId", Values: [state.runId] },
              { Name: "domain", Values: ["vpc"] },
            ],
          }),
        );
        if (existing.Addresses?.length && existing.Addresses[0]?.AllocationId) {
          allocationId = existing.Addresses[0].AllocationId;
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
            extras: {
              reason: "eip_reuse",
              allocationId,
              message: `Reusing existing EIP ${allocationId} from previous attempt`,
            },
          });
          // L-A6: DescribeAddresses may return multiple EIPs tagged with the
          // same runId from prior leaked attempts. We reuse the first one but
          // emit a warn-level log so operators can manually clean up the rest.
          if (existing.Addresses.length > 1) {
            const allAllocationIds = existing.Addresses.map(
              (a) => a.AllocationId,
            ).filter((id): id is string => typeof id === "string");
            log({
              ts: new Date().toISOString(),
              runId: state.runId,
              level: "warn",
              action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
              extras: {
                reason: "eip_leak_detected",
                count: existing.Addresses.length,
                reusedAllocationId: allocationId,
                allAllocationIds,
                message:
                  `Found ${existing.Addresses.length} EIPs tagged with runId ${state.runId} ` +
                  `from previous attempts. Reusing ${allocationId}; the rest are leaked and ` +
                  `require manual cleanup via 'aws ec2 release-address'.`,
              },
            });
          }
        }
      } catch (err) {
        // Wave 19 Bug #5: promote AccessDenied to a warn-level event with an
        // actionable hint. The previous info-level swallow meant every
        // compound VPC run in an account with a stale operator policy
        // silently allocated a fresh EIP, hiding the underlying IAM gap.
        // The reuse path is still non-fatal (we fall through to allocate
        // a new EIP so the user's intent succeeds), but the log is now
        // greppable at warn level and names the remediation.
        const errMsg = err instanceof Error ? err.message : String(err);
        const isAccessDenied =
          errMsg.includes("not authorized") ||
          errMsg.includes("UnauthorizedOperation") ||
          errMsg.includes("AccessDenied");
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: isAccessDenied ? "warn" : "info",
          action: LOG_ACTIONS.STATE_GUARD_SKIPPED,
          extras: {
            phase: "describe_addresses_eip_reuse",
            error: formatErrorForLog(err),
            ...(isAccessDenied && {
              hint:
                "Operator role lacks ec2:DescribeAddresses. This is already in " +
                "iam-actions.ts for EC2_NAT_GATEWAY as of Wave 19 Bug #5 — run " +
                "`assignee setup` to refresh AssigneeOperatorPolicy in AWS. " +
                "Falling through to allocate a fresh EIP (leak-prone until " +
                "setup is re-run).",
            }),
          },
        });
      }

      if (!allocationId) {
        const eipResult = await ec2.send(
          new AllocateAddressCommand({ Domain: "vpc" }),
        );
        allocationId = eipResult.AllocationId;
        if (!allocationId) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage:
              "EIP allocation succeeded but returned no AllocationId.",
            desiredState,
          };
        }
        // C1: Mark this EIP as fresh-allocated so cleanup releases it on
        // failure. Reused EIPs (found via DescribeAddresses above) must NOT
        // be released on failure — they belong to a previous attempt.
        eipAllocatedThisInvocation = true;
        // Tag the EIP with runId AND the standard managed-by tag.
        //
        // Wave 19 Bug #6: before this fix, EIPs were tagged ONLY with
        // `assignee:runId`, NOT with `managed-by=assignee-ai`. This meant:
        //   1. `fetchManagedResources` (which RGTA-filters on
        //      `managed-by=assignee-ai`) never returned the EIP, so it was
        //      invisible to `assignee list` and `assignee destroy --all`.
        //   2. Combined with the absence of `AWS::EC2::EIP` from the
        //      bulk-destroy tier table, every compound VPC apply leaked
        //      exactly 1 EIP at ~$3.60/month forever.
        //   3. The 2026-04-08 live smoke recovered 6 leaked EIPs from prior
        //      runs, all stranded by this exact bug.
        // Adding the managed-by tag here brings EIPs into the same destroy
        // path as every other primary resource type.
        try {
          await ec2.send(
            new CreateTagsCommand({
              Resources: [allocationId],
              Tags: [
                { Key: "assignee:runId", Value: state.runId },
                { Key: TAG_KEY_MANAGED_BY, Value: TAG_VALUE_MANAGED_BY },
              ],
            }),
          );
        } catch (err) {
          // Tagging failure is non-fatal — EIP is still usable
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
            extras: {
              phase: "tag_eip",
              allocationId,
              error: formatErrorForLog(err),
            },
          });
        }
      }

      desiredState[CfnKey.ALLOCATION_ID] = allocationId;
    } catch (eipErr: unknown) {
      const errMsg = eipErr instanceof Error ? eipErr.message : String(eipErr);
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `EIP allocation failed for NatGateway: ${errMsg}`,
        // H9: surface cloned desiredState even on failure so retries can
        // see any mutations (e.g. partially-resolved AllocationId).
        desiredState,
      };
    }
  }

  // ── SSH key pair creation for EC2 (deferred from plan_generator) ─────────
  // Only auto-create when the placeholder was injected by plan_generator.
  // User-supplied key names are assumed to already exist in AWS.
  let sshKeyCreatedName: string | undefined;
  // C2: distinguish "verify failed (can't tell if key exists)" from "create
  // actually failed". Transient verify errors must NOT silently strip KeyName
  // — that would permanently SSH-lock the user out of a successfully
  // provisioned EC2 instance. Only strip KeyName when the create itself fails.
  let sshKeyCreateAttempted = false;
  if (
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
    desiredState[CfnKey.KEY_NAME] === ResourceDefault.SSH_KEY_PLACEHOLDER
  ) {
    try {
      const { EC2Client, CreateKeyPairCommand, DescribeKeyPairsCommand } =
        await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region: AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const keyName = ResourceDefault.SSH_KEY_PLACEHOLDER;

      // Check if key pair already exists — only catch "not found" errors
      let keyExists = false;
      try {
        await ec2.send(new DescribeKeyPairsCommand({ KeyNames: [keyName] }));
        keyExists = true;
      } catch (descErr: unknown) {
        const errName =
          descErr instanceof Error ? (descErr as { name?: string }).name : "";
        if (errName !== "InvalidKeyPair.NotFound") {
          // Rethrow permission/throttle/network errors — don't assume key is missing
          throw descErr;
        }
      }

      if (!keyExists) {
        sshKeyCreateAttempted = true;
        const keyResult = await ec2.send(
          new CreateKeyPairCommand({ KeyName: keyName }),
        );
        if (!keyResult.KeyMaterial) {
          throw new Error(
            "AWS returned empty KeyMaterial — key pair may not have been created correctly",
          );
        }
        // V1 N3 audit (2026-04-06): set the cleanup tracker IMMEDIATELY after
        // AWS confirms the key was created — BEFORE any local filesystem work
        // can throw. mkdirSync (or any subsequent fs error) used to leave the
        // tracker undefined, leaking a key in AWS without a corresponding
        // local .pem file and no cleanup record.
        sshKeyCreatedName = keyName;
        // Save private key to ~/.assignee/keys/
        const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        // Sanitize key name for filesystem safety. Whitelist [A-Za-z0-9._-]
        // and reject leading dots — blocks null bytes, path separators,
        // control chars, newlines, leading-dot dotfiles, Windows reserved
        // names like CON/PRN (which contain only safe chars but get rejected
        // by the leading-letter heuristic when paired with the .pem suffix
        // on case-insensitive filesystems — handled by sanitizeKeyName).
        const safeKeyName = sanitizeKeyName(keyName);
        const keysDir = join(homedir(), ASSIGNEE_DIR, "keys");
        // Mode 0o700 — keys directory must NOT be world-readable. The
        // .pem files inside are 0o400 but a 0o755 directory leaks the
        // listing of provisioned key names to other local users.
        mkdirSync(keysDir, { recursive: true, mode: 0o700 });
        // Re-chmod in case the directory already existed with a wider mode.
        try {
          chmodSync(keysDir, 0o700);
        } catch {
          // Best effort — Windows or unusual filesystems may reject chmod.
        }
        const keyPath = join(keysDir, `${safeKeyName}.pem`);
        writeFileSync(keyPath, keyResult.KeyMaterial, { mode: 0o400 });
        process.stderr.write(
          `\u001B[33m🔑 SSH key pair created: ${keyPath}\u001B[0m\n`,
        );
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: { sshKeyCreated: keyName, keyPath },
        });
      }
    } catch (keyErr: unknown) {
      const errMsg = keyErr instanceof Error ? keyErr.message : String(keyErr);
      if (!sshKeyCreateAttempted) {
        // C2: Couldn't even verify whether the key exists (transient error,
        // throttle, AccessDenied, missing creds, network). Fail the resource
        // with a clear error — DO NOT silently strip KeyName, because if the
        // key actually exists in AWS the instance would be provisioned with
        // no keypair and the user would be permanently SSH-locked-out.
        process.stderr.write(
          `\u001B[33m⚠️  SSH key pair verification failed: ${errMsg}\u001B[0m\n`,
        );
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "error",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: { sshKeyVerifyError: errMsg },
        });
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `SSH key pair verification failed (cannot confirm whether key exists — refusing to provision EC2 instance without keypair): ${errMsg}`,
          // H9: surface the cloned desiredState even on failure.
          desiredState,
        };
      }
      // Create itself failed — safe to strip KeyName and proceed so the
      // instance can still be provisioned (just without SSH access).
      process.stderr.write(
        `\u001B[33m⚠️  SSH key pair creation failed: ${errMsg}\u001B[0m\n`,
      );
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
        extras: { sshKeyError: errMsg },
      });
      // Remove KeyName so CloudControl doesn't fail referencing a missing key
      delete desiredState[CfnKey.KEY_NAME];
    }
  }

  // ── Inject mandatory tags (NFR-14) ───────────────────────────────────────
  const propertiesWithTags = injectMandatoryTags(
    desiredState,
    state.runId,
    state.resourceType,
  );

  // CloudFront Distribution: wait for S3 bucket DNS propagation before
  // creating. CCAPI accepts the CreateResource call synchronously but the
  // async status check validates the S3 origin DomainName — if DNS hasn't
  // propagated yet, the poll returns FAILED with "does not refer to a
  // valid S3 bucket". Since the failure is ASYNC (status-poller, not
  // createResource), a create-level retry doesn't help. A pre-create
  // delay of 10s gives S3 DNS time to propagate in us-east-1 before
  // CCAPI's validator runs.
  if (
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    state.completedResources?.some(
      (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET,
    )
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
      extras: { phase: "cloudfront_s3_dns_wait", delay: 30000 },
    });
    await new Promise((r) => setTimeout(r, 30000));
  }

  // ── CloudControl async create ─────────────────────────────────────────────
  // Compound patterns reuse runId across resources — append index for unique
  // ClientToken. H11: ALSO append a random per-attempt suffix so retrying the
  // same (runId, currentResourceIndex) pair produces a NEW ClientToken.
  // Without this, CloudControl returns the cached prior failure record
  // forever and the user cannot retry without abandoning the runId.
  //
  // V1 N1: Slice to 12 hex chars (48 bits of entropy). The previous 8-char
  // slice gave only 32 bits, with a birthday-paradox collision boundary at
  // ~65k retries — feasible inside a long-running loop. 48 bits pushes the
  // boundary to ~16.7M retries, well outside any realistic usage.
  const { randomUUID } = await import("node:crypto");
  const attemptSuffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const indexSuffix =
    state.currentResourceIndex != null && state.currentResourceIndex > 0
      ? `-${state.currentResourceIndex}`
      : "";
  const clientToken = `${state.runId}${indexSuffix}-${attemptSuffix}`;

  let [createErr, createResult] = await provisioner.createResource(
    state.resourceType,
    JSON.stringify(propertiesWithTags),
    clientToken,
  );

  // CloudFront Distribution: retry on S3 origin DNS propagation delay.
  // CloudFront validates the S3 bucket DomainName immediately at create
  // time, but S3 bucket DNS in us-east-1 takes up to 30s to propagate
  // globally. When the distribution is in a compound pattern where the
  // S3 bucket was just created seconds ago, the first create attempt
  // fails with "does not refer to a valid S3 bucket". Retry with
  // exponential backoff (5s, 10s, 20s) to wait for DNS propagation.
  if (
    createErr &&
    state.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
    createErr.message?.includes("does not refer to a valid S3 bucket")
  ) {
    const retryDelays = [5000, 10000, 20000];
    for (const delay of retryDelays) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.PROVISIONING_STATUS_CHECKED,
        extras: {
          phase: "cloudfront_s3_dns_retry",
          delay,
          attempt: retryDelays.indexOf(delay) + 1,
        },
      });
      await new Promise((r) => setTimeout(r, delay));
      const retryToken = `${state.runId}${indexSuffix}-${(await import("node:crypto")).randomUUID().replace(/-/g, "").slice(0, 12)}`;
      [createErr, createResult] = await provisioner.createResource(
        state.resourceType,
        JSON.stringify(propertiesWithTags),
        retryToken,
      );
      if (!createErr) break;
      if (!createErr.message?.includes("does not refer to a valid S3 bucket"))
        break;
    }
  }

  if (createErr) {
    const isBucketAlreadyExists =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS &&
      state.resourceType === RESOURCE_TYPES.S3_BUCKET;
    const errorCategory =
      createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? PROVISIONING_ERROR_CODES.ALREADY_EXISTS
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? PROVISIONING_ERROR_CODES.THROTTLED
          : PROVISIONING_ERROR_CODES.UNKNOWN;
    const prefix = isBucketAlreadyExists
      ? "S3 bucket name is already taken globally. Choose a different name."
      : createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
        ? "Resource already exists. Choose a different name."
        : createErr.kind === ProvisioningErrorKind.THROTTLED
          ? "Request throttled by AWS. Please wait and retry."
          : createErr.message;
    // Release EIP if we allocated one for NatGateway — best-effort cleanup.
    // C1: ONLY release EIPs that were freshly allocated in this invocation.
    // Reused EIPs (found via DescribeAddresses from a prior attempt) must
    // survive so the NEXT retry can also reuse them — otherwise the retry
    // loop defeats the reuse design and we leak one EIP per failure.
    if (
      state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
      eipAllocatedThisInvocation &&
      desiredState[CfnKey.ALLOCATION_ID] &&
      desiredState[CfnKey.ALLOCATION_ID] !== EIP_AUTO_ALLOCATE
    ) {
      try {
        const { EC2Client, ReleaseAddressCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({
          region: AWS_REGION,
          credentials: requireAssigneeCredentials("operator"),
        });
        await ec2.send(
          new ReleaseAddressCommand({
            AllocationId: desiredState[CfnKey.ALLOCATION_ID] as string,
          }),
        );
      } catch (err) {
        // best-effort cleanup — surface as info so operators can diagnose EIP leaks
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: {
            phase: "release_eip_after_failure",
            allocationId: desiredState[CfnKey.ALLOCATION_ID],
            error: formatErrorForLog(err),
          },
        });
      }
    }
    // Delete SSH key pair if we created one — best-effort cleanup
    if (sshKeyCreatedName) {
      try {
        const { EC2Client, DeleteKeyPairCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({
          region: AWS_REGION,
          credentials: requireAssigneeCredentials("operator"),
        });
        await ec2.send(
          new DeleteKeyPairCommand({ KeyName: sshKeyCreatedName }),
        );
      } catch (err) {
        // best-effort cleanup — surface as info so operators can diagnose key leaks
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: {
            phase: "delete_ssh_key_after_failure",
            sshKeyName: sshKeyCreatedName,
            error: formatErrorForLog(err),
          },
        });
      }
    }

    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `CloudControl provisioning failed: ${prefix}`,
      error: new ProvisioningError(
        createErr.kind === ProvisioningErrorKind.ALREADY_EXISTS
          ? "Resource already exists"
          : createErr.kind === ProvisioningErrorKind.THROTTLED
            ? "Request throttled by AWS"
            : createErr.message,
        errorCategory,
      ),
      // H9: ALWAYS surface the cloned desiredState back to the reducer —
      // even on failure. A retry node downstream must see any allocated
      // EIPs / resolved identifiers so they can be reused on the next
      // attempt instead of leaking a fresh resource per retry.
      desiredState,
    };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
    extras: {
      requestToken: createResult!.requestToken,
      resourceType: state.resourceType,
    },
  });

  return {
    requestToken: createResult!.requestToken,
    executionStatus: ExecutionStatus.IN_PROGRESS,
    startedAt: Date.now(),
    // Item F: surface the (possibly mutated) clone via the reducer instead
    // of in-place mutation of state.desiredState.
    desiredState,
  };
}
