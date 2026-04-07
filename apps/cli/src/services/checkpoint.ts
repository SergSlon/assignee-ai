/**
 * Checkpoint serialization service — save/load/find domain-level plan checkpoints.
 *
 * @see Story 10.1
 * @see architecture.md#Checkpoint Serialization
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
  PlanCheckpointSchema,
  CHECKPOINT_VERSION,
  CheckpointError,
  safeTry,
  CostEstimateLabel,
  type PlanCheckpoint,
} from "@assignee/core";
import type { AgentState } from "./graph-state.js";
import {
  CHECKPOINT_DEFAULT_TTL_HOURS,
  CHECKPOINT_FILE_PREFIX,
  CLEANUP_SKIP_RECENT_MINUTES,
  UNKNOWN_FALLBACK,
} from "../config/constants.js";

/**
 * Explicit allowlist of fully-qualified CloudFormation property names that
 * carry secret material. We use an exact-match allowlist (NOT a substring
 * regex) because real CFN schemas contain many legitimate property names
 * that share substrings with sensitive words but are NOT secrets:
 *
 *   - PasswordPolicy            (Cognito UserPool — password complexity rules)
 *   - UserData                  (EC2 instance bootstrap script)
 *   - TokenValidityUnits        (Cognito JWT lifetime descriptor)
 *   - PasswordResetRequired     (IAM LoginProfile flag, NOT the password)
 *   - CredentialReportExpiration (IAM credential report metadata)
 *
 * Redacting these would silently strip critical infrastructure config on
 * checkpoint resume (a Cognito UserPool re-created without password policy,
 * an EC2 instance launched without its bootstrap script, etc.).
 *
 * @see SECURITY-AUDIT.md — SEC-02 / H17 (W2-B regression REG-N1)
 */
const SENSITIVE_KEY_NAMES: ReadonlySet<string> = new Set([
  // RDS / DocDB / DAX / Workspaces master credentials
  "MasterUserPassword",
  "MasterPassword",
  "AdminPassword",
  "DefaultPassword",
  "DefaultUserPassword",
  // Generic top-level password (IAM LoginProfile, SecretsManager, etc.)
  "Password",
  // Secrets Manager secret payload
  "SecretString",
  // IAM AccessKey / STS session credentials
  "SecretAccessKey",
  "SessionToken",
  // Certificate Manager / Key Pair private key material
  "PrivateKey",
  "PrivateKeyPassphrase",
  "RSAPrivateKey",
  // EKS / cluster bootstrap tokens
  "BootstrapToken",
]);

/**
 * Pattern for AWS access key identifiers (AKIA = long-term IAM access keys,
 * ASIA = STS short-term session credentials). Any string value matching this
 * pattern is redacted regardless of its key name. This is defense-in-depth
 * over the key allowlist — it walks values, so it has no false-positive risk
 * on innocuously-named properties.
 *
 * We deliberately do NOT try to match the 40-char base64 secret-access-key
 * shape: it is too generic and would false-positive on bucket names, ARNs,
 * and other long opaque identifiers.
 */
const AKIA_PATTERN = /A[KS]IA[0-9A-Z]{16}/;

/** Value used to mask redacted fields. */
const REDACTED_VALUE = "[REDACTED]";

/**
 * Recursively redact sensitive keys and AKIA-pattern values from a
 * desiredState record. Walks arrays and nested objects. Pure — returns a new
 * object rather than mutating the input.
 */
function redactSensitiveFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SENSITIVE_KEY_NAMES.has(key)) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = redactValue(value);
  }
  return result;
}

/**
 * Recursively redact a value. Scalars that match the AKIA pattern are masked.
 * Objects and arrays are walked element-by-element.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return AKIA_PATTERN.test(value) ? REDACTED_VALUE : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value && typeof value === "object") {
    return redactSensitiveFields(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Remove fields with "[REDACTED]" values from a desiredState record.
 * Recurses into nested objects. Prevents sending placeholder strings to AWS.
 */
function stripRedactedFields(
  state: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === REDACTED_VALUE) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = stripRedactedFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extracts serializable fields from GraphState into a PlanCheckpoint.
 * Excludes: messages, resourceSchema, resourcePattern (non-serializable).
 * Redacts sensitive fields (MasterUserPassword, SecretString) from desiredState.
 */
export function serializeCheckpoint(state: AgentState): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: CHECKPOINT_DEFAULT_TTL_HOURS,
    runId: state.runId,
    userIntent: state.userIntent,
    resourceType: state.resourceType ?? UNKNOWN_FALLBACK,
    resourcePatternId: state.resourcePattern?.patternId ?? undefined,
    resourceQueue: state.resourceQueue
      ? state.resourceQueue.map((r) => ({
          resourceId: r.resourceId,
          resourceType: r.resourceType,
          displayName: r.displayName,
          desiredState: {},
        }))
      : undefined,
    desiredState: redactSensitiveFields(state.desiredState ?? {}),
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
    preflightPassed: state.preflightPassed,
    elicitedOptions: state.elicitedOptions,
  };
}

/**
 * Writes a checkpoint to disk as JSON.
 * Creates the directory if it doesn't exist.
 *
 * @returns The absolute file path written.
 */
export async function saveCheckpoint(
  checkpoint: PlanCheckpoint,
  dir: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `checkpoint-${checkpoint.runId}.json`);
  // Use a per-call random suffix instead of process.pid so two concurrent
  // saveCheckpoint() invocations from the same process (or two processes that
  // happened to share a recycled PID) cannot collide on the temp filename.
  const tmpPath = `${filePath}.tmp.${randomBytes(8).toString("hex")}`;
  // Write with 0o600 so the checkpoint is never world-readable. rename() on
  // POSIX inherits the source file's mode, so we also chmod the final path as
  // defence-in-depth against umask or pre-existing-file edge cases.
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best-effort on filesystems that don't support chmod (e.g. some Windows
    // configurations). The writeFile mode is authoritative on POSIX.
  }
  return filePath;
}

/**
 * Loads and validates a checkpoint by runId.
 * Throws CheckpointError on parse failure.
 */
export async function loadCheckpoint(
  runId: string,
  dir: string,
): Promise<PlanCheckpoint> {
  const filePath = path.join(dir, `checkpoint-${runId}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CheckpointError(
      `Corrupt checkpoint file (invalid JSON): ${filePath}`,
    );
  }
  const parsed = PlanCheckpointSchema.strict().safeParse(json);
  if (!parsed.success) {
    throw new CheckpointError(
      `Invalid checkpoint file: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Checks whether a checkpoint has exceeded its TTL.
 */
function isCheckpointExpired(checkpoint: PlanCheckpoint): boolean {
  const createdMs = new Date(checkpoint.created_at).getTime();
  const expiresMs = createdMs + checkpoint.ttl_hours * 60 * 60 * 1000;
  return Date.now() > expiresMs;
}

/**
 * Loads and validates a checkpoint from an explicit file path.
 * Validates schema, TTL, preflight status, and desiredState presence.
 *
 * @throws CheckpointError on missing file, invalid schema, expired TTL, or incomplete checkpoint.
 * @see Story 11.3
 */
export async function loadCheckpointFromPath(
  filePath: string,
): Promise<PlanCheckpoint> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new CheckpointError(
      `Checkpoint file not found: ${filePath}. Run \`assignee plan\` to create a new plan.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Backup corrupt file for debugging
    try {
      await fs.copyFile(filePath, `${filePath}.corrupt.${Date.now()}`);
    } catch {
      /* best-effort */
    }
    throw new CheckpointError(
      `Corrupt checkpoint file (invalid JSON): ${filePath}`,
    );
  }

  const parsed = PlanCheckpointSchema.strict().safeParse(json);
  if (!parsed.success) {
    throw new CheckpointError(
      `Invalid checkpoint file: ${parsed.error.message}`,
    );
  }

  const cp = parsed.data;

  // TTL validation
  if (isCheckpointExpired(cp)) {
    const createdDate = new Date(cp.created_at).toLocaleString();
    throw new CheckpointError(
      `Checkpoint expired: created ${createdDate}, TTL ${cp.ttl_hours}h. Run \`assignee plan\` to create a new plan.`,
    );
  }

  // Validate checkpoint completeness for Phase 2
  if (!cp.preflightPassed) {
    throw new CheckpointError(
      `Checkpoint did not pass preflight validation. Run \`assignee plan\` to create a new plan.`,
    );
  }

  if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) {
    throw new CheckpointError(
      `Checkpoint has no desiredState. Run \`assignee plan\` to create a new plan.`,
    );
  }

  // Strip redacted fields so they are never sent to AWS on resume.
  // AWS will use defaults (e.g., auto-generated passwords) for omitted fields.
  cp.desiredState = stripRedactedFields(cp.desiredState);

  return cp;
}

/**
 * Prunes expired checkpoint files from a directory.
 * Keeps the 3 newest checkpoints regardless of expiry, and skips recently modified files.
 *
 * @param dir - Directory containing checkpoint-*.json files
 * @param opts.skipRecentMinutes - Skip files modified within this many minutes (default 10)
 * @returns Count of pruned and kept files
 * @see Story 33.2
 */
export async function pruneExpiredCheckpoints(
  dir: string,
  opts: { skipRecentMinutes?: number } = {},
): Promise<{ pruned: number; kept: number }> {
  const skipRecentMs =
    (opts.skipRecentMinutes ?? CLEANUP_SKIP_RECENT_MINUTES) * 60 * 1000;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { pruned: 0, kept: 0 };
  }

  const files = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );
  if (files.length === 0) return { pruned: 0, kept: 0 };

  const now = Date.now();

  interface FileInfo {
    filePath: string;
    createdAt: number;
    expired: boolean;
    mtime: number;
  }
  const infos: FileInfo[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    let mtime: number;
    try {
      const stat = await fs.stat(filePath);
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    let createdAt: number;
    let expired: boolean;
    try {
      const json = JSON.parse(raw);
      createdAt = new Date(json.created_at).getTime();
      const ttlHours = typeof json.ttl_hours === "number" ? json.ttl_hours : 72;
      expired = now > createdAt + ttlHours * 60 * 60 * 1000;
    } catch {
      createdAt = 0;
      expired = true;
      mtime = 0;
    }
    infos.push({ filePath, createdAt, expired, mtime });
  }

  // Sort newest first
  infos.sort((a, b) => b.createdAt - a.createdAt);

  let pruned = 0;
  let kept = 0;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    // Keep the 3 newest regardless
    if (i < 3) {
      kept++;
    } else if (now - info.mtime < skipRecentMs) {
      kept++;
    } else if (!info.expired) {
      kept++;
    } else {
      // Prune this file
      try {
        await fs.unlink(info.filePath);
        pruned++;
      } catch {
        kept++; // Failed to delete — count as kept
      }
    }
  }

  return { pruned, kept };
}

/**
 * Scans a directory for checkpoint files, filters by TTL, returns the newest valid one.
 * Returns null if none are valid or the directory doesn't exist.
 */
export async function findNewestValidCheckpoint(
  dir: string,
): Promise<PlanCheckpoint | null> {
  const [readErr, entries] = await safeTry(fs.readdir(dir));
  if (readErr) return null;

  const checkpointFiles = entries.filter(
    (f) => f.startsWith(CHECKPOINT_FILE_PREFIX) && f.endsWith(".json"),
  );

  if (checkpointFiles.length === 0) return null;

  let newest: PlanCheckpoint | null = null;
  let newestTime = 0;

  for (const file of checkpointFiles) {
    const [err, raw] = await safeTry(
      fs.readFile(path.join(dir, file), "utf-8"),
    );
    if (err) continue;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // skip corrupt files
    }
    const parsed = PlanCheckpointSchema.safeParse(json);
    if (!parsed.success) continue;

    const cp = parsed.data;
    if (isCheckpointExpired(cp)) continue; // expired
    if (!cp.preflightPassed) continue; // failed preflight
    if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) continue; // empty plan

    const createdMs = new Date(cp.created_at).getTime();
    if (createdMs > newestTime) {
      newest = cp;
      newestTime = createdMs;
    }
  }

  return newest;
}
