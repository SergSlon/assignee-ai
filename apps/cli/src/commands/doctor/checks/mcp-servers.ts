/**
 * Doctor check #3 — MCP server launchability.
 *
 * Spawns each pinned MCP server with `--help` (uvx-supported, side-effect
 * free). A quick exit (0/1/2) within the timeout is treated as `ok`; we
 * deliberately do NOT call `tools/list` over stdio because the transport
 * setup costs 200–800ms per server and would push doctor over its 10s
 * budget.
 */

import { spawn } from "node:child_process";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
  MCP_PINS,
} from "../../../config/mcp-servers.js";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../types.js";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { padPin, rollup } from "../util.js";

export interface McpCheckDeps {
  /** Override the spawn function (test injection). */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

interface CatalogEntry {
  key: string;
  pin: string;
  configKey: string;
}

/** Static catalogue surfaced as one row per pinned server. */
const CATALOG: CatalogEntry[] = [
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

export async function checkMcpServers(
  deps: McpCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const spawnFn = deps.spawnImpl ?? spawn;

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

  for (const entry of CATALOG) {
    const config = core[entry.configKey] ?? optional[entry.configKey];
    if (!config) {
      subs.push({
        label: padPin(entry.pin),
        status: "warn",
        detail: "skipped — required role credentials not configured",
      });
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
  }

  const okCount = subs.filter((s) => s.status === "ok").length;
  return {
    name: `MCP servers (${okCount}/${subs.length} ok)`,
    status: rollup(subs),
    subs,
  };
}

/**
 * Spawn `command --help` and resolve once it exits or the timeout fires.
 * Treats exit-code 0/1/2 as success — we're really only checking that the
 * binary launches at all.
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
      if (code === 0 || code === 1 || code === 2) {
        finish(true, `launched (${command})`);
      } else {
        finish(false, `${command} exited with code ${code ?? "null"}`);
      }
    });
  });
}
