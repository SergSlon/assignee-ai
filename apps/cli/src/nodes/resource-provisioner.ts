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
  CCAPI_FALLBACK_TYPES,
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
import { injectMandatoryTags } from "../utils/tags.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { AWS_REGION, ASSIGNEE_DIR } from "../config/constants.js";
import type { AgentState } from "../services/graph-state.js";

function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}

export async function resourceProvisionerNode(
  state: AgentState,
  provisioner: ProvisioningPort,
  fallbackDispatcher?: SDKFallbackDispatcher,
): Promise<Partial<AgentState>> {
  if (state.executionStatus === ExecutionStatus.CANCELLED) return {};

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

    // Check SDK-routable types (can be provisioned via native SDK)
    if (fallbackDispatcher.canHandle(state.resourceType)) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.SDK_FALLBACK_DISPATCHED,
        extras: {
          resourceType: state.resourceType,
          dispatchPath: "sdk_fallback",
        },
      });

      // Inject tags for EventSourceMapping (supports Tags parameter)
      // SNS Subscriptions do NOT support tags at creation time
      const desiredStateForSdk =
        state.resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING
          ? injectMandatoryTags(
              state.desiredState,
              state.runId,
              state.resourceType,
            )
          : state.desiredState;

      if (
        state.resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING
      ) {
        const [err, result] =
          await fallbackDispatcher.createEventSourceMapping(desiredStateForSdk);
        if (err) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `SDK fallback provisioning failed: ${err.message}`,
            error: new ProvisioningError(
              err.message,
              PROVISIONING_ERROR_CODES.UNKNOWN,
            ),
          };
        }
        return {
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: result.identifier,
        };
      }

      if (state.resourceType === CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION) {
        const [err, result] = await fallbackDispatcher.subscribe(
          state.desiredState,
        );
        if (err) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `SDK fallback provisioning failed: ${err.message}`,
            error: new ProvisioningError(
              err.message,
              PROVISIONING_ERROR_CODES.UNKNOWN,
            ),
          };
        }
        return {
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: result.identifier,
        };
      }
    }
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
    : getPrimaryIdentifier(state.resourceType, state.desiredState);

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
  if (
    state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
    state.desiredState[CfnKey.ALLOCATION_ID] === EIP_AUTO_ALLOCATE
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
        }
      } catch {
        // DescribeAddresses failure is non-fatal — fall through to allocate a new EIP
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
          };
        }
        // Tag the EIP with runId so it can be found on retry
        try {
          await ec2.send(
            new CreateTagsCommand({
              Resources: [allocationId],
              Tags: [{ Key: "assignee:runId", Value: state.runId }],
            }),
          );
        } catch {
          // Tagging failure is non-fatal — EIP is still usable
        }
      }

      state.desiredState[CfnKey.ALLOCATION_ID] = allocationId;
    } catch (eipErr: unknown) {
      const errMsg = eipErr instanceof Error ? eipErr.message : String(eipErr);
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `EIP allocation failed for NatGateway: ${errMsg}`,
      };
    }
  }

  // ── SSH key pair creation for EC2 (deferred from plan_generator) ─────────
  // Only auto-create when the placeholder was injected by plan_generator.
  // User-supplied key names are assumed to already exist in AWS.
  let sshKeyCreatedName: string | undefined;
  if (
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
    state.desiredState[CfnKey.KEY_NAME] === ResourceDefault.SSH_KEY_PLACEHOLDER
  ) {
    try {
      const { EC2Client, CreateKeyPairCommand, DescribeKeyPairsCommand } =
        await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region: AWS_REGION });
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
        const keyResult = await ec2.send(
          new CreateKeyPairCommand({ KeyName: keyName }),
        );
        if (!keyResult.KeyMaterial) {
          throw new Error(
            "AWS returned empty KeyMaterial — key pair may not have been created correctly",
          );
        }
        // Save private key to ~/.assignee/keys/
        const { mkdirSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        // Sanitize key name for filesystem safety (strip path separators)
        const safeKeyName = keyName
          .replace(/[/\\]/g, "_")
          .replace(/\.\./g, "_");
        const keysDir = join(homedir(), ASSIGNEE_DIR, "keys");
        mkdirSync(keysDir, { recursive: true });
        const keyPath = join(keysDir, `${safeKeyName}.pem`);
        sshKeyCreatedName = keyName; // Track before write so cleanup runs if write fails
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
      delete state.desiredState[CfnKey.KEY_NAME];
    }
  }

  // ── Inject mandatory tags (NFR-14) ───────────────────────────────────────
  const propertiesWithTags = injectMandatoryTags(
    state.desiredState,
    state.runId,
    state.resourceType,
  );

  // ── CloudControl async create ─────────────────────────────────────────────
  // Compound patterns reuse runId across resources — append index for unique ClientToken
  const clientToken =
    state.currentResourceIndex != null && state.currentResourceIndex > 0
      ? `${state.runId}-${state.currentResourceIndex}`
      : state.runId;

  const [createErr, createResult] = await provisioner.createResource(
    state.resourceType,
    JSON.stringify(propertiesWithTags),
    clientToken,
  );

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
    // Release EIP if we allocated one for NatGateway — best-effort cleanup
    if (
      state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
      state.desiredState[CfnKey.ALLOCATION_ID] &&
      state.desiredState[CfnKey.ALLOCATION_ID] !== EIP_AUTO_ALLOCATE
    ) {
      try {
        const { EC2Client, ReleaseAddressCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({
          region: AWS_REGION,
        });
        await ec2.send(
          new ReleaseAddressCommand({
            AllocationId: state.desiredState[CfnKey.ALLOCATION_ID] as string,
          }),
        );
      } catch {
        /* best-effort cleanup */
      }
    }
    // Delete SSH key pair if we created one — best-effort cleanup
    if (sshKeyCreatedName) {
      try {
        const { EC2Client, DeleteKeyPairCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({ region: AWS_REGION });
        await ec2.send(
          new DeleteKeyPairCommand({ KeyName: sshKeyCreatedName }),
        );
      } catch {
        /* best-effort cleanup */
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
    };
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
    extras: {
      requestToken: createResult.requestToken,
      resourceType: state.resourceType,
    },
  });

  return {
    requestToken: createResult.requestToken,
    executionStatus: ExecutionStatus.IN_PROGRESS,
    startedAt: Date.now(),
  };
}
