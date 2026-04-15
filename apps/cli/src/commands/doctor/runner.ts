/**
 * Doctor orchestration.
 *
 * Runs every diagnostic in parallel (within the 10s budget), composes a
 * `DoctorReport`, and computes the exit code. Skip flags preserve the
 * `--skip-bedrock` / `--skip-mcp` / `--skip-mcp-version-check` UX.
 *
 * The runner depends only on the check interfaces — not on concrete
 * check implementations (DIP). Tests inject fakes through the *Deps
 * parameters on each check.
 */

import {
  checkCredentials,
  type CredentialsCheckDeps,
} from "./checks/credentials.js";
import { checkBedrock, type BedrockCheckDeps } from "./checks/bedrock.js";
import { checkMcpServers, type McpCheckDeps } from "./checks/mcp-servers.js";
import {
  checkMcpVersionDrift,
  type McpVersionCheckDeps,
} from "./checks/mcp-version-drift.js";
import { checkCache, type CacheCheckDeps } from "./checks/cache.js";
import { checkConfig, type ConfigCheckDeps } from "./checks/config.js";
import {
  checkBestPractices,
  type BpCheckDeps,
} from "./checks/best-practices.js";
import { checkLlmRouting } from "./checks/llm-routing.js";
import type { CheckStatus, DoctorReport, DoctorSection } from "./types.js";
import { buildSummary, statusToExit } from "./formatter.js";
import { worse } from "./util.js";

export interface RunDoctorDeps {
  version?: string;
  credentialsDeps?: CredentialsCheckDeps;
  bedrockDeps?: BedrockCheckDeps;
  mcpDeps?: McpCheckDeps;
  cacheDeps?: CacheCheckDeps;
  configDeps?: ConfigCheckDeps;
  bpDeps?: BpCheckDeps;
  /** Override the MCP version drift check (test injection). */
  mcpVersionDeps?: McpVersionCheckDeps;
  /** Skip the Bedrock invoke (fast path used by tests / CI smoke). */
  skipBedrock?: boolean;
  /** Skip the MCP launch probe (fast path used by tests). */
  skipMcp?: boolean;
  /** Skip the MCP version drift check (fast path used by tests). */
  skipMcpVersionCheck?: boolean;
}

/** Build a standard "section skipped" placeholder. */
function skippedSection(name: string, reason: string): DoctorSection {
  return {
    name,
    status: "warn",
    subs: [{ label: "skipped", status: "warn", detail: reason }],
  };
}

/**
 * Run every doctor section and return the composed report.
 * Sections run in parallel with `Promise.all` to fit the 10s budget.
 */
export async function runDoctor(
  deps: RunDoctorDeps = {},
): Promise<DoctorReport> {
  const version = deps.version ?? "0.0.0";

  const [credentials, bedrock, mcp, mcpVersionDrift] = await Promise.all([
    checkCredentials(deps.credentialsDeps),
    deps.skipBedrock
      ? Promise.resolve(skippedSection("Bedrock (skipped)", "skipBedrock=true"))
      : checkBedrock(deps.bedrockDeps),
    deps.skipMcp
      ? Promise.resolve(skippedSection("MCP servers (skipped)", "skipMcp=true"))
      : checkMcpServers(deps.mcpDeps),
    deps.skipMcpVersionCheck
      ? Promise.resolve(
          skippedSection(
            "MCP version drift (skipped)",
            "skipMcpVersionCheck=true",
          ),
        )
      : checkMcpVersionDrift(deps.mcpVersionDeps),
  ]);

  const cache = checkCache(deps.cacheDeps);
  const config = checkConfig(deps.configDeps);
  const bp = checkBestPractices(deps.bpDeps);

  // Story 44.1: show routing table when per-node LLM config exists.
  const llmRouting = await checkLlmRouting();

  const sections: DoctorSection[] = [
    credentials,
    bedrock,
    ...(llmRouting ? [llmRouting] : []),
    mcp,
    mcpVersionDrift,
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
