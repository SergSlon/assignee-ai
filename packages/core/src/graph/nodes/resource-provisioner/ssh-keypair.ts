/**
 * EC2 SSH key pair pre-provision.
 *
 * The plan generator writes `KeyName = ResourceDefault.SSH_KEY_PLACEHOLDER`
 * to mark "please auto-create a keypair at apply time". User-supplied
 * KeyNames skip this module entirely and are expected to already exist.
 *
 * Flow:
 *   1. DescribeKeyPairs — does the placeholder key already exist?
 *      - ONLY `InvalidKeyPair.NotFound` counts as "not found". Any other
 *        error (throttle, AccessDenied, missing creds, network) is rethrown
 *        up to the verify-failure branch so we NEVER silently proceed
 *        without SSH access.
 *   2. If not found: CreateKeyPair, then write the PEM to
 *      `~/.assignee/keys/<sanitized>.pem` with mode 0o400 (dir 0o700).
 *   3. On any failure:
 *      - `verify-failed` (could not DescribeKeyPairs) → FAIL the resource.
 *        Silently stripping KeyName would SSH-lock the user out of a
 *        successfully provisioned instance (C2 invariant).
 *      - `create-failed` (DescribeKeyPairs said not-found, CreateKeyPair
 *        threw) → strip KeyName and proceed so the instance still comes up.
 *
 * Returns the created key name (undefined if none created) and a result
 * discriminator the caller uses to decide whether to short-circuit.
 *
 * SRP: this module changes when SSH-keypair rules change.
 */

import {
  CfnKey,
  ExecutionStatus,
  RESOURCE_TYPES,
  ResourceDefault,
  createEC2Client,
} from "@assignee/core";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";
import { AWS_REGION } from "../../../config/constants/aws.js";
import { ASSIGNEE_DIR } from "../../../config/constants/paths.js";
import { requireAssigneeCredentials } from "../../../config/aws-credentials.js";
import { sanitizeKeyName } from "./util.js";

export type SshKeypairResult =
  | {
      ok: true;
      /** Name of the key created in THIS invocation, undefined if none. */
      sshKeyCreatedName: string | undefined;
    }
  | {
      ok: false;
      partial: Partial<AgentState>;
      /** Pass to cleanup so a partially-created key is released. */
      sshKeyCreatedName: string | undefined;
    };

/**
 * Resolve the SSH_KEY_PLACEHOLDER in `desiredState` in place.
 * No-ops unless resourceType is EC2::Instance AND KeyName matches
 * the placeholder.
 */
export async function ensureSshKeypair(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<SshKeypairResult> {
  if (
    state.resourceType !== RESOURCE_TYPES.EC2_INSTANCE ||
    desiredState[CfnKey.KEY_NAME] !== ResourceDefault.SSH_KEY_PLACEHOLDER
  ) {
    return { ok: true, sshKeyCreatedName: undefined };
  }

  // C2: distinguish "verify failed (can't tell if key exists)" from
  // "create actually failed". Only strip KeyName when CREATE fails.
  let sshKeyCreateAttempted = false;
  let sshKeyCreatedName: string | undefined;

  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    const { CreateKeyPairCommand, DescribeKeyPairsCommand } =
      await import("@aws-sdk/client-ec2");
    ec2 = createEC2Client({
      region: AWS_REGION,
      credentials: requireAssigneeCredentials("operator"),
    });
    const keyName = ResourceDefault.SSH_KEY_PLACEHOLDER;

    let keyExists = false;
    try {
      await ec2.send(new DescribeKeyPairsCommand({ KeyNames: [keyName] }));
      keyExists = true;
    } catch (descErr: unknown) {
      const errName =
        descErr instanceof Error ? (descErr as { name?: string }).name : "";
      if (errName !== "InvalidKeyPair.NotFound") {
        // Rethrow permission/throttle/network — don't assume key is missing.
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
      // V1 N3: set cleanup tracker IMMEDIATELY after AWS confirms the
      // key was created — before any local fs work can throw, or we'd
      // leak a key in AWS with no cleanup record.
      sshKeyCreatedName = keyName;
      const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const safeKeyName = sanitizeKeyName(keyName);
      const keysDir = join(homedir(), ASSIGNEE_DIR, "keys");
      // Mode 0o700 — keys dir must NOT be world-readable.
      mkdirSync(keysDir, { recursive: true, mode: 0o700 });
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
      // C2: verify failed — FAIL the resource. Silent KeyName stripping
      // would SSH-lock-out the user if the key actually exists.
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
        ok: false,
        sshKeyCreatedName,
        partial: {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `SSH key pair verification failed (cannot confirm whether key exists — refusing to provision EC2 instance without keypair): ${errMsg}`,
          desiredState,
        },
      };
    }
    // Create itself failed — strip KeyName so instance can still come up
    // (just without SSH access).
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
    delete desiredState[CfnKey.KEY_NAME];
  } finally {
    ec2?.destroy();
  }

  return { ok: true, sshKeyCreatedName };
}
