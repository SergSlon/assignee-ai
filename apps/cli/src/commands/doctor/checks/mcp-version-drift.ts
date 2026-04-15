/**
 * Doctor check #3b — MCP server version drift vs PyPI.
 *
 * Runs after the liveness check so a network hiccup here never masks a
 * more serious "MCP won't even start" problem. Never returns `fail` —
 * drift is informational, not blocking (bumping pins is a deliberate
 * human decision).
 *
 * @see Story 45.6
 */

import {
  checkMcpVersions,
  type McpVersionCheckResult,
} from "../../../services/mcp-version-check.js";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../types.js";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { padPin, rollup, withTimeout } from "../util.js";

/** Injection seam so doctor tests don't hit PyPI. */
export interface McpVersionCheckDeps {
  /** Override the version-check function (test injection). */
  checkVersionsImpl?: () => Promise<McpVersionCheckResult[]>;
}

export async function checkMcpVersionDrift(
  deps: McpVersionCheckDeps = {},
): Promise<DoctorSection> {
  const checkFn = deps.checkVersionsImpl ?? checkMcpVersions;

  // Per-MCP fetches already carry a 5s AbortController inside the
  // service, but on offline runners with broken DNS, AbortController
  // doesn't always unblock pre-connect lookups in time. Wrap the whole
  // call in a section-level deadline so this section never blows the
  // budget.
  let results: McpVersionCheckResult[];
  try {
    results = await withTimeout(
      checkFn(),
      DEFAULT_CHECK_TIMEOUT_MS,
      "MCP version drift check timed out",
    );
  } catch (err) {
    return {
      name: "MCP version drift",
      status: "warn",
      subs: [
        {
          label: "version check failed",
          status: "warn",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  const subs: DoctorSubCheck[] = results.map((r) => {
    const label = padPin(`${r.packageName}@${r.pinnedVersion}`);
    if (r.status === "up-to-date") {
      return { label, status: "ok", detail: "latest" };
    }
    if (r.status === "behind") {
      return {
        label,
        status: "warn",
        detail: `latest: ${r.latestVersion ?? "unknown"} (drift — review release notes and bump deliberately)`,
      };
    }
    return {
      label,
      status: "warn",
      detail: `version check failed: ${r.error ?? "unknown error"}`,
    };
  });

  const upToDateCount = subs.filter((s) => s.status === "ok").length;
  return {
    name: `MCP version drift (${upToDateCount}/${subs.length} up-to-date)`,
    status: rollup(subs),
    subs,
  };
}
