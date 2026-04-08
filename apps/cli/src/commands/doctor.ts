/**
 * `assignee doctor` command — non-destructive end-to-end health check.
 *
 * Verifies the six critical preconditions for a successful `plan`/`apply`:
 *   1. AWS credentials for each of the 3 IAM roles (live STS GetCallerIdentity)
 *   2. Bedrock (or configured LLM provider) reachability with a tiny prompt
 *   3. MCP server launchability (pricing, docs, IAM, well-architected, billing)
 *   4. Local cache health (~/.assignee size, oldest checkpoint, log file count)
 *   5. Project configuration file presence + validity
 *   6. Best-practices manifest integrity (SHA-256 hash match)
 *
 * Exit codes:
 *   0 — all green
 *   1 — at least one hard failure (✗)
 *   2 — only warnings (!)
 *
 * Doctor MUST NOT mutate any state — every check is read-only. Each check
 * has a 5-second timeout so the whole command stays under the 10s budget
 * even on slow connections (constraint #6 in the spec).
 *
 * @see Sally UX audit — "doctor / whoami diagnostics"
 */

import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  ASSIGNEE_ROLES,
  envVarsForRole,
  tryAssigneeCredentials,
  ASSIGNEE_DIR,
  SUPPORTED_TYPES_ARRAY,
  defaultPatternRegistry,
  type AssigneeRole,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import {
  computeManifest,
  verifyManifest,
  computeFreshness,
  loadBestPractices,
} from "@assignee/best-practices";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { EnvVar } from "../constants/env-vars.js";
import { ProcessExitCode } from "../constants/errors.js";
import { AWS_REGION } from "../config/constants.js";
import { LlmAdapter, DEFAULT_MODEL } from "../services/llm-adapter.js";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
  MCP_PINS,
} from "../config/mcp-servers.js";

/** Per-check deadline. Spec constraint #6: <10s total, 5s per check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

/** Status of a single doctor check or sub-check. */
export type CheckStatus = "ok" | "warn" | "fail";

/** A single doctor sub-check line (e.g. one credential role). */
export interface DoctorSubCheck {
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** A top-level doctor section (e.g. "Credentials"). */
export interface DoctorSection {
  name: string;
  status: CheckStatus;
  summary?: string;
  subs: DoctorSubCheck[];
}

/** The complete doctor report. */
export interface DoctorReport {
  version: string;
  sections: DoctorSection[];
  /** Aggregate exit code derived from `sections`. */
  exitCode: number;
  /** Human-readable rollup line at the bottom. */
  summary: string;
}

/** Glyphs used for terminal output (Unicode like flutter doctor). */
const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
};

/**
 * Best-effort wrapper that resolves a promise or rejects after `ms`.
 *
 * EX-7 regression fix: we MUST clear the underlying setTimeout handle once
 * the wrapped promise settles. Without this, the Node event loop stays
 * alive for the full `ms` window after every successful check, making the
 * whole `doctor` command block for ~ms × checks even when every call was
 * fast. The 5-second-per-check budget is still enforced — we just don't
 * hold the process hostage when the call was actually quick.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** Worst-of two statuses (fail > warn > ok). */
function worse(a: CheckStatus, b: CheckStatus): CheckStatus {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

/** Roll up an array of sub-check statuses into a section status. */
function rollup(subs: DoctorSubCheck[]): CheckStatus {
  return subs.reduce<CheckStatus>((acc, s) => worse(acc, s.status), "ok");
}

// ── 1. Credentials check ──────────────────────────────────────────────────

/** Long-term IAM access key prefix; ASIA = STS session, both accepted. */
const ACCESS_KEY_SHAPE = /^(AKIA|ASIA)[0-9A-Z]{16}$/;

export interface CredentialsCheckDeps {
  stsClientFactory?: (
    creds: ExplicitAwsCredentials,
    region: string,
  ) => {
    send: (cmd: GetCallerIdentityCommand) => Promise<{
      Account?: string;
      Arn?: string;
      UserId?: string;
    }>;
  };
  timeoutMs?: number;
}

/**
 * Verify each Assignee role's credentials by calling STS GetCallerIdentity.
 *
 * Reports per-role: env-var presence, access-key shape, STS reachability,
 * resolved Account + ARN. A role with no env vars is reported as `warn`
 * (only operator is strictly required to plan/apply); a role with env vars
 * but a failing STS call is `fail`.
 */
export async function checkCredentials(
  deps: CredentialsCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const factory =
    deps.stsClientFactory ??
    ((c: ExplicitAwsCredentials, r: string) =>
      new STSClient({
        region: r,
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
        },
      }));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  for (const role of ASSIGNEE_ROLES) {
    const vars = envVarsForRole(role);
    const creds = tryAssigneeCredentials(role);

    if (!creds) {
      subs.push({
        label: padRole(role),
        status: role === "operator" ? "fail" : "warn",
        detail: `not set (${vars.accessKey})`,
      });
      continue;
    }

    if (!ACCESS_KEY_SHAPE.test(creds.accessKeyId)) {
      // Shape is advisory only — STS will be the source of truth.
      subs.push({
        label: padRole(role),
        status: "warn",
        detail: `access key shape unusual: ${maskKey(creds.accessKeyId)}`,
      });
      continue;
    }

    try {
      const client = factory(creds, AWS_REGION);
      const result = await withTimeout(
        client.send(new GetCallerIdentityCommand({})),
        timeoutMs,
        `STS for ${role}`,
      );
      if (!result.Account || !result.Arn) {
        subs.push({
          label: padRole(role),
          status: "fail",
          detail: `STS returned empty identity`,
        });
        continue;
      }
      subs.push({
        label: padRole(role),
        status: "ok",
        detail: `${maskKey(creds.accessKeyId)} → ${result.Arn}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      subs.push({
        label: padRole(role),
        status: "fail",
        detail: `STS GetCallerIdentity failed: ${msg}`,
      });
    }
  }

  return {
    name: "Credentials",
    status: rollup(subs),
    subs,
  };
}

/** Pad role names to a fixed width for column alignment. */
function padRole(role: AssigneeRole): string {
  return role.padEnd(8, " ");
}

/** Mask an access key for display (show prefix only — never the secret). */
function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ── 2. Bedrock / LLM access ───────────────────────────────────────────────

export interface BedrockCheckDeps {
  /** Override the LLM adapter used for the check (test injection). */
  llmFactory?: () => {
    generateText: (
      prompt: string,
      options?: { maxTokens?: number },
    ) => Promise<readonly [Error | null, string | null]>;
  };
  timeoutMs?: number;
}

/**
 * Confirm the configured LLM provider responds to a tiny "hello" prompt.
 *
 * We use `LlmAdapter.generateText` so the check honours the same env vars
 * as the rest of the CLI (`ASSIGNEE_MODEL`, guardrails, etc.) — no separate
 * code path that could mask provider misconfiguration.
 */
export async function checkBedrock(
  deps: BedrockCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const modelString = process.env[EnvVar.ASSIGNEE_MODEL] ?? DEFAULT_MODEL;
  const guardrailId = process.env[EnvVar.BEDROCK_GUARDRAIL_ID];
  const guardrailVersion = process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const adapter =
    deps.llmFactory?.() ??
    new LlmAdapter({
      modelString,
      ...(guardrailId ? { guardrailId } : {}),
      ...(guardrailVersion ? { guardrailVersion } : {}),
    });

  // Operator credentials are required for the bedrock provider; if they
  // are not set, we cannot do the live invoke. Skip the gating check when
  // an llmFactory is injected (tests provide their own adapter that does
  // not touch AWS).
  const wantsBedrock = modelString.startsWith("bedrock/");
  if (!deps.llmFactory && wantsBedrock && !tryAssigneeCredentials("operator")) {
    subs.push({
      label: `LLM (${modelString})`,
      status: "fail",
      detail: `operator credentials required for bedrock provider`,
    });
    return {
      // Tier S #2: header reflects the ACTUAL model that will be used,
      // not the BEDROCK_MODEL_ID default. When the user sets ASSIGNEE_MODEL
      // to override the model (e.g. for testing the Wave 12 region-error
      // hint), the header used to lie and show the default model name even
      // though the LLM call below correctly used the override. The
      // modelString variable already incorporates the env override.
      name: `Bedrock (${AWS_REGION}, model ${modelString.replace(/^bedrock\//, "")}${guardrailId ? `, guardrail ${guardrailId}:${guardrailVersion ?? "1"}` : ""})`,
      status: "fail",
      subs,
    };
  }

  try {
    const [err, text] = await withTimeout(
      adapter.generateText("hello", { maxTokens: 16 }),
      timeoutMs,
      "LLM invoke",
    );
    if (err) {
      subs.push({
        label: `LLM (${modelString})`,
        status: "fail",
        detail: err.message,
      });
    } else if (!text || text.trim().length === 0) {
      subs.push({
        label: `LLM (${modelString})`,
        status: "warn",
        detail: "empty response (model is reachable but returned no text)",
      });
    } else {
      subs.push({
        label: `LLM (${modelString})`,
        status: "ok",
        detail: `responded (${text.trim().slice(0, 40).replace(/\s+/g, " ")}…)`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    subs.push({
      label: `LLM (${modelString})`,
      status: "fail",
      detail: msg,
    });
  }

  if (guardrailId) {
    subs.push({
      label: "Guardrail",
      status: "ok",
      detail: `${guardrailId}:${guardrailVersion ?? "1"} (configured)`,
    });
  }

  return {
    // Tier S #2: header reflects the ACTUAL model that will be used,
    // not the BEDROCK_MODEL_ID default. When the user sets ASSIGNEE_MODEL
    // to override the model (e.g. for testing the Wave 12 region-error
    // hint), the header used to lie and show the default model name even
    // though the LLM call below correctly used the override. The
    // modelString variable already incorporates the env override.
    name: `Bedrock (${AWS_REGION}, model ${modelString.replace(/^bedrock\//, "")}${guardrailId ? `, guardrail ${guardrailId}:${guardrailVersion ?? "1"}` : ""})`,
    status: rollup(subs),
    subs,
  };
}

// ── 3. MCP servers ────────────────────────────────────────────────────────

export interface McpCheckDeps {
  /** Override the spawn function (test injection). */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

/**
 * Probe each pinned MCP server by spawning the configured command with
 * `--help` (a uvx-supported, side-effect-free flag). A non-error exit
 * within the timeout is treated as `ok`. We deliberately do NOT call
 * `tools/list` over stdio — that would require initialising MCP transport
 * which costs 200–800ms per server and would push doctor over the 10s
 * budget when all 5 servers are checked sequentially.
 */
export async function checkMcpServers(
  deps: McpCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const spawnFn = deps.spawnImpl ?? spawn;

  // Build the union of core + optional servers, swallowing missing-creds
  // errors per-server so we can still report which servers are checkable.
  const allServers: Array<{ name: string; pin: string; command: string }> = [];

  let core: Record<string, { command: string; args: string[] }> = {};
  try {
    core = getMcpServerConfigs();
  } catch {
    // Reader creds missing — handled per-server below.
  }
  let optional: Record<string, { command: string; args: string[] }> = {};
  try {
    optional = getOptionalMcpServerConfigs();
  } catch {
    // Auditor creds missing — handled per-server below.
  }

  // Static catalogue of servers we want to report on. Use MCP_PINS as the
  // single source of truth so we surface a row per pinned server even when
  // its credentials are unavailable (rather than silently omitting it).
  const catalog: Array<{ key: string; pin: string; configKey: string }> = [
    {
      key: "aws-pricing-mcp-server",
      pin: MCP_PINS.AWS_PRICING,
      configKey: "aws-pricing-mcp-server",
    },
    {
      key: "aws-documentation-mcp-server",
      pin: MCP_PINS.AWS_DOCUMENTATION,
      configKey: "aws-documentation-mcp-server",
    },
    {
      key: "iam-mcp-server",
      pin: MCP_PINS.AWS_IAM,
      configKey: "iam-mcp-server",
    },
    {
      key: "well-architected-security-mcp-server",
      pin: MCP_PINS.AWS_WA_SECURITY,
      configKey: "well-architected-security-mcp-server",
    },
    {
      key: "aws-cost-management-mcp-server",
      pin: MCP_PINS.AWS_COST_MANAGEMENT,
      configKey: "aws-cost-management-mcp-server",
    },
  ];

  for (const entry of catalog) {
    const config = core[entry.configKey] ?? optional[entry.configKey];
    if (!config) {
      subs.push({
        label: padPin(entry.pin),
        status: "warn",
        detail: "skipped — required role credentials not configured",
      });
      allServers.push({ name: entry.key, pin: entry.pin, command: "skipped" });
      continue;
    }
    const result = await pingMcpServer(
      config.command,
      config.args,
      timeoutMs,
      spawnFn,
    );
    subs.push({
      label: padPin(entry.pin),
      status: result.ok ? "ok" : "fail",
      detail: result.detail,
    });
    allServers.push({
      name: entry.key,
      pin: entry.pin,
      command: config.command,
    });
  }

  const okCount = subs.filter((s) => s.status === "ok").length;
  return {
    name: `MCP servers (${okCount}/${subs.length} ok)`,
    status: rollup(subs),
    subs,
  };
}

/** Pad a pin like "awslabs.aws-pricing-mcp-server@1.0.6" for column alignment. */
function padPin(pin: string): string {
  return pin.padEnd(48, " ");
}

/**
 * Spawn `command --help` and resolve once it exits or the timeout fires.
 * Treats exit-code 0 OR 1 (uvx prints help to stderr+exit 0; some servers
 * exit non-zero on `--help`) as success — we're really only checking that
 * the binary launches at all.
 */
async function pingMcpServer(
  command: string,
  args: string[],
  timeoutMs: number,
  spawnFn: typeof spawn,
): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolveOnce) => {
    let resolved = false;
    const finish = (ok: boolean, detail: string): void => {
      if (resolved) return;
      resolved = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore — process may already be dead.
      }
      resolveOnce({ ok, detail });
    };

    let proc: ReturnType<typeof spawn>;
    try {
      // Pass --help as the LAST arg so uvx still resolves the package first.
      proc = spawnFn(command, [...args, "--help"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
      return;
    }

    const timer = setTimeout(() => {
      finish(false, `launch timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      finish(false, err.message);
    });

    proc.on("exit", (code: number | null) => {
      clearTimeout(timer);
      // uvx prints help on exit 0; some MCP packages exit 2 on `--help`.
      // Both prove that uvx + the package can be resolved.
      if (code === 0 || code === 1 || code === 2) {
        finish(true, `launched (${command})`);
      } else {
        finish(false, `${command} exited with code ${code ?? "null"}`);
      }
    });
  });
}

// ── 4. Cache health ───────────────────────────────────────────────────────

export interface CacheCheckDeps {
  homeDir?: string;
}

/**
 * Inspect ~/.assignee/ for total size, oldest checkpoint age, and log
 * file count. Read-only — never deletes anything (use `assignee clean`
 * for that).
 */
export function checkCache(deps: CacheCheckDeps = {}): DoctorSection {
  const home = deps.homeDir ?? join(os.homedir(), ASSIGNEE_DIR);
  const subs: DoctorSubCheck[] = [];

  if (!existsSync(home)) {
    subs.push({
      label: home,
      status: "warn",
      detail: "directory does not exist (will be created on first run)",
    });
    return { name: "Cache", status: "warn", subs };
  }

  const totalBytes = walkDirSize(home);
  const checkpoints = listCheckpoints(home);
  const logCount = countLogs(join(home, "logs"));

  const oldestCheckpointAgeHours =
    checkpoints.length === 0
      ? 0
      : Math.floor(
          (Date.now() - Math.min(...checkpoints.map((c) => c.mtimeMs))) /
            (1000 * 60 * 60),
        );

  // Stale = older than 72h (default checkpoint TTL).
  const staleCheckpoints = checkpoints.filter(
    (c) => Date.now() - c.mtimeMs > 72 * 60 * 60 * 1000,
  ).length;

  const summary =
    `${formatBytes(totalBytes)}, ${staleCheckpoints} stale checkpoints, ${logCount} log files` +
    (oldestCheckpointAgeHours > 0
      ? `, oldest checkpoint ${oldestCheckpointAgeHours}h`
      : "");

  subs.push({
    label: home,
    status: staleCheckpoints > 0 ? "warn" : "ok",
    detail: summary,
  });

  return {
    name: "Cache",
    status: rollup(subs),
    subs,
  };
}

/** Recursively sum file sizes under `dir`. Errors are silently ignored. */
function walkDirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += walkDirSize(p);
        } else if (entry.isFile()) {
          total += statSync(p).size;
        }
      } catch {
        // Skip unreadable entries.
      }
    }
  } catch {
    // Skip unreadable directories.
  }
  return total;
}

/** List checkpoint files (`checkpoint-*.json`) under `dir`. */
function listCheckpoints(
  dir: string,
): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith("checkpoint-") &&
        entry.name.endsWith(".json")
      ) {
        const p = join(dir, entry.name);
        try {
          out.push({ path: p, mtimeMs: statSync(p).mtimeMs });
        } catch {
          // Skip — race with concurrent cleanup.
        }
      }
    }
  } catch {
    // Directory missing — return empty list.
  }
  return out;
}

/** Count `.jsonl` files under the logs subdir. */
function countLogs(logsDir: string): number {
  try {
    return readdirSync(logsDir).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

/** Format a byte count as KB / MB / GB with one decimal. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// ── 5. Project config ────────────────────────────────────────────────────

export interface ConfigCheckDeps {
  cwd?: string;
}

/**
 * Look for an Assignee project config file in the cwd. The file is
 * optional (the CLI works without it), but if present we surface its
 * path. We do not validate schema here — `assignee init` does that —
 * we only confirm it parses as YAML.
 */
export function checkConfig(deps: ConfigCheckDeps = {}): DoctorSection {
  const cwd = deps.cwd ?? process.cwd();
  const subs: DoctorSubCheck[] = [];
  const candidates = [
    "assignee.yaml",
    "assignee.yml",
    join(".assignee", "config.yaml"),
  ];
  let found: string | undefined;
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) {
      found = c;
      break;
    }
  }

  if (!found) {
    subs.push({
      label: "project config",
      status: "warn",
      detail: "no assignee.yaml in cwd (optional — defaults will be used)",
    });
    return { name: "Config", status: "warn", subs };
  }

  // Cheap parse check — `yaml` is already a direct dep of the CLI.
  // Schema validation lives in init.ts; doctor only confirms it parses.
  try {
    const content = readFileSync(join(cwd, found), "utf-8");
    parseYaml(content);
    subs.push({
      label: `./${found}`,
      status: "ok",
      detail: "valid YAML",
    });
  } catch (err) {
    subs.push({
      label: `./${found}`,
      status: "fail",
      detail: `failed to parse: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    name: "Config",
    status: rollup(subs),
    subs,
  };
}

// ── 6. Best practices integrity ──────────────────────────────────────────

export interface BpCheckDeps {
  bpDir?: string;
}

/**
 * Verify the BP library against its committed manifest, count rules,
 * and surface freshness. The manifest lives at
 * `packages/best-practices/manifest.json` and is regenerated on every
 * release; a hash mismatch means a BP file was edited without rebuilding
 * the manifest, which could indicate tampering or a stale checkout.
 */
export function checkBestPractices(deps: BpCheckDeps = {}): DoctorSection {
  const subs: DoctorSubCheck[] = [];
  const bpDir =
    deps.bpDir ??
    resolve(import.meta.dirname, "../../../../packages/best-practices");

  let ruleCount = 0;
  try {
    ruleCount = loadBestPractices(bpDir).length;
  } catch (err) {
    subs.push({
      label: "rule load",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { name: "Best practices", status: "fail", subs };
  }

  try {
    const manifest = computeManifest(bpDir);
    const referencePath = join(bpDir, "manifest.json");
    const verify = verifyManifest(manifest, referencePath);
    if (verify.valid && verify.trustOnFirstUse) {
      subs.push({
        label: "manifest",
        status: "warn",
        detail: `${ruleCount} rules — no reference manifest (trust on first use)`,
      });
    } else if (verify.valid) {
      subs.push({
        label: "manifest",
        status: "ok",
        detail: `${ruleCount} rules, hash ${manifest.hash.slice(0, 12)}… matches`,
      });
    } else {
      subs.push({
        label: "manifest",
        status: "fail",
        detail: verify.reason ?? "manifest mismatch",
      });
    }
  } catch (err) {
    subs.push({
      label: "manifest",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const fresh = computeFreshness(bpDir);
    if (fresh.isStale) {
      subs.push({
        label: "freshness",
        status: "warn",
        detail: `oldest rule ${fresh.oldestAgeDays}d (> ${fresh.staleThresholdDays}d threshold)`,
      });
    }
  } catch {
    // Freshness is informational only — never fails the section.
  }

  // A8 follow-up: surface the resource-type and compound-pattern
  // counts next to the BP rule count so operators can see at a
  // glance what surface area assignee can provision. These lines
  // are informational — never fail or warn — so they slot after the
  // manifest + freshness checks which can actually fail.
  subs.push({
    label: "coverage",
    status: "ok",
    detail: `${SUPPORTED_TYPES_ARRAY.length} resource types, ${defaultPatternRegistry.size()} compound patterns`,
  });

  return {
    name: "Best practices",
    status: rollup(subs),
    subs,
  };
}

// ── Render ────────────────────────────────────────────────────────────────

/** Convert a status to its terminal exit code (0 / 1 / 2). */
function statusToExit(status: CheckStatus): number {
  if (status === "fail") return ProcessExitCode.GENERIC_ERROR;
  if (status === "warn") return 2;
  return ProcessExitCode.SUCCESS;
}

/** Pretty-print a single section. */
export function renderSection(section: DoctorSection): string {
  const glyph = STATUS_GLYPH[section.status];
  const lines = [`[${glyph}] ${section.name}`];
  for (const sub of section.subs) {
    const subGlyph = STATUS_GLYPH[sub.status];
    const detail = sub.detail ? ` → ${sub.detail}` : "";
    lines.push(`    • ${subGlyph} ${sub.label}${detail}`);
  }
  return lines.join("\n");
}

/** Pretty-print the full report. */
export function renderReport(report: DoctorReport): string {
  const out: string[] = [`Doctor summary (assignee.ai ${report.version}):`];
  for (const section of report.sections) {
    out.push(renderSection(section));
  }
  out.push("");
  out.push(report.summary);
  out.push("");
  return out.join("\n");
}

/** Build the human summary line ("X issues found", or "No issues found!"). */
function buildSummary(sections: DoctorSection[]): string {
  const fails = sections.filter((s) => s.status === "fail").length;
  const warns = sections.filter((s) => s.status === "warn").length;
  if (fails === 0 && warns === 0) return "No issues found!";
  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} failure${fails === 1 ? "" : "s"}`);
  if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  return `! ${parts.join(", ")} found.`;
}

// ── Orchestration ─────────────────────────────────────────────────────────

export interface RunDoctorDeps {
  version?: string;
  credentialsDeps?: CredentialsCheckDeps;
  bedrockDeps?: BedrockCheckDeps;
  mcpDeps?: McpCheckDeps;
  cacheDeps?: CacheCheckDeps;
  configDeps?: ConfigCheckDeps;
  bpDeps?: BpCheckDeps;
  /** Skip the Bedrock invoke (fast path used by tests / CI smoke). */
  skipBedrock?: boolean;
  /** Skip the MCP launch probe (fast path used by tests). */
  skipMcp?: boolean;
}

/**
 * Run all 6 doctor sections and return the full report.
 * Sections run in parallel with `Promise.all` to fit the 10s budget.
 */
export async function runDoctor(
  deps: RunDoctorDeps = {},
): Promise<DoctorReport> {
  const version = deps.version ?? "0.0.0";

  const [credentials, bedrock, mcp] = await Promise.all([
    checkCredentials(deps.credentialsDeps),
    deps.skipBedrock
      ? Promise.resolve<DoctorSection>({
          name: `Bedrock (skipped)`,
          status: "warn",
          subs: [
            { label: "skipped", status: "warn", detail: "skipBedrock=true" },
          ],
        })
      : checkBedrock(deps.bedrockDeps),
    deps.skipMcp
      ? Promise.resolve<DoctorSection>({
          name: `MCP servers (skipped)`,
          status: "warn",
          subs: [{ label: "skipped", status: "warn", detail: "skipMcp=true" }],
        })
      : checkMcpServers(deps.mcpDeps),
  ]);

  const cache = checkCache(deps.cacheDeps);
  const config = checkConfig(deps.configDeps);
  const bp = checkBestPractices(deps.bpDeps);

  const sections: DoctorSection[] = [
    credentials,
    bedrock,
    mcp,
    cache,
    config,
    bp,
  ];

  const overall = sections.reduce<CheckStatus>(
    (acc, s) => worse(acc, s.status),
    "ok",
  );

  return {
    version,
    sections,
    exitCode: statusToExit(overall),
    summary: buildSummary(sections),
  };
}

// ── Commander wiring ─────────────────────────────────────────────────────

/** Read the CLI version from `apps/cli/package.json` (best-effort). */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const doctorCommand = new Command(CommandName.DOCTOR)
  .description(CommandDescription.DOCTOR)
  .option("--json", "Emit the report as JSON instead of formatted text")
  .option("--skip-bedrock", "Skip the Bedrock LLM invoke check")
  .option("--skip-mcp", "Skip the MCP server launch probe")
  .action(
    async (opts: {
      json?: boolean;
      skipBedrock?: boolean;
      skipMcp?: boolean;
    }) => {
      const report = await runDoctor({
        version: readPackageVersion(),
        ...(opts.skipBedrock ? { skipBedrock: true } : {}),
        ...(opts.skipMcp ? { skipMcp: true } : {}),
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(renderReport(report));
      }

      if (report.exitCode !== ProcessExitCode.SUCCESS) {
        process.exitCode = report.exitCode;
      }
    },
  );
