/**
 * MCP version drift detection.
 *
 * Walks every entry in `MCP_PINS` (the single source of truth in
 * `config/mcp-servers.ts`), parses each pin into `package@version`, fetches
 * the latest stable version from PyPI's JSON API, and reports whether each
 * MCP server is `up-to-date`, `behind`, or `fetch-failed`.
 *
 * This service is intentionally **read-only** — it surfaces drift, it never
 * bumps pins. Bumping is a deliberate human decision per the comment on
 * `MCP_PINS` (and the trail of bugs that proved why automated bumps are
 * unsafe — see Stories 45.1, 45.2, 45.3, 45.4 retrospectives).
 *
 * @see Story 45.6 — MCP version drift monitoring (doctor + CI gate)
 */

import { MCP_PINS } from "../config/mcp-servers.js";

/** Per-MCP version-check outcome. */
export interface McpVersionCheckResult {
  /** PyPI package name, e.g. `awslabs.aws-pricing-mcp-server`. */
  packageName: string;
  /** Version pinned in `MCP_PINS`, e.g. `1.0.27`. */
  pinnedVersion: string;
  /** Latest stable version from PyPI, or `null` if the fetch failed. */
  latestVersion: string | null;
  /** Outcome — `up-to-date`, `behind`, or `fetch-failed`. */
  status: "up-to-date" | "behind" | "fetch-failed";
  /** Error detail when `status === "fetch-failed"`. */
  error?: string;
}

/** Default per-request timeout for the PyPI fetch. */
const PYPI_FETCH_TIMEOUT_MS = 5000;

/**
 * Split a pin like `awslabs.aws-pricing-mcp-server@1.0.27` into
 * `{ packageName, pinnedVersion }`. Splits on the LAST `@` so the dotted
 * package prefix is preserved verbatim.
 *
 * @throws if the pin contains no `@` separator
 */
export function parsePin(pin: string): {
  packageName: string;
  pinnedVersion: string;
} {
  const at = pin.lastIndexOf("@");
  if (at <= 0 || at === pin.length - 1) {
    throw new Error(
      `Invalid MCP pin format: ${pin} (expected "package@version")`,
    );
  }
  return {
    packageName: pin.slice(0, at),
    pinnedVersion: pin.slice(at + 1),
  };
}

/**
 * Compare two dotted version strings the way semver would for the simple
 * `MAJOR.MINOR.PATCH` shape used by all upstream MCP servers as of
 * 2026-04-11. Returns -1 if a<b, 0 if equal, 1 if a>b.
 *
 * Components are parsed as integers so `1.0.27 > 1.0.5` (as opposed to
 * lexicographic compare which would say the opposite). Trailing missing
 * components are treated as zero (`1.0` === `1.0.0`).
 *
 * If a component is non-numeric (e.g. a pre-release tag like `1.0.0rc1`),
 * the function falls back to a string comparison on the original input —
 * good enough for "is this not equal" detection without pulling in `semver`.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  // Detect any non-purely-numeric component up front. Lenient parseInt
  // would happily turn "0rc1" into 0, masking pre-release tags.
  const STRICT_INT = /^\d+$/;
  const allNumeric =
    aParts.every((p) => STRICT_INT.test(p)) &&
    bParts.every((p) => STRICT_INT.test(p));
  if (!allNumeric) {
    // Pre-release tag or other non-numeric content — fall back to string
    // compare on the original input. This is good enough for "are these
    // not equal" detection without dragging in `semver`.
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  for (let i = 0; i < len; i++) {
    const aNum = Number.parseInt(aParts[i] ?? "0", 10);
    const bNum = Number.parseInt(bParts[i] ?? "0", 10);
    if (aNum < bNum) return -1;
    if (aNum > bNum) return 1;
  }
  return 0;
}

/**
 * Fetch the latest stable version of a PyPI package via the JSON API.
 *
 * Uses native `fetch` (Node 22+) and an `AbortController` for the timeout
 * so a hung registry never blocks the doctor command. Throws on any
 * non-success outcome — callers (notably {@link checkMcpVersions}) wrap
 * the call in `Promise.allSettled` so a single failure does not poison the
 * other rows.
 *
 * @throws on timeout, non-2xx, malformed JSON, or missing `info.version`
 */
export async function fetchLatestVersion(
  packageName: string,
  signal: AbortSignal,
): Promise<string> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `PyPI fetch failed: ${response.status} ${response.statusText}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new Error(
      `PyPI returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Narrow the unknown payload defensively — PyPI is stable but mocks in
  // tests are easy to get wrong, and we'd rather throw than silently misread.
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("info" in payload) ||
    typeof (payload as { info: unknown }).info !== "object" ||
    (payload as { info: unknown }).info === null
  ) {
    throw new Error("PyPI response missing `info` object");
  }
  const info = (payload as { info: Record<string, unknown> }).info;
  const version = info["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("PyPI response `info.version` is not a non-empty string");
  }
  return version;
}

/**
 * Walk every entry in `MCP_PINS`, fetch the latest version for each
 * package in parallel, and return per-MCP drift results.
 *
 * Network behavior:
 * - 5-second timeout per fetch via a per-call `AbortController`
 * - Failures are isolated via `Promise.allSettled` — one MCP timing out
 *   does not affect the rows for the other four
 * - Network failures map to `status: "fetch-failed"` with the error
 *   message preserved in `error` for the doctor row's `detail` field
 */
export async function checkMcpVersions(): Promise<McpVersionCheckResult[]> {
  // checkSinglePin is built to never throw — it converts all error paths
  // (parsePin failure, fetch error, abort, malformed JSON) into a fulfilled
  // McpVersionCheckResult with status="fetch-failed". So we can just await
  // every promise in parallel; Promise.allSettled would be defensive against
  // a state that cannot exist.
  return Promise.all(Object.values(MCP_PINS).map((pin) => checkSinglePin(pin)));
}

// ── CI-script helpers ───────────────────────────────────────────────────────
// These live here (not in `apps/cli/scripts/`) because the CLI package's
// `tsconfig.json` only includes `src/**/*.ts`. Putting the helpers under src/
// lets `vitest` reach them via the standard test pattern. The actual
// `apps/cli/scripts/check-mcp-versions.ts` script is a 5-line wrapper that
// imports from here.

/** Format a single result row for the script's stdout summary. */
export function formatScriptRow(r: McpVersionCheckResult): string {
  const prefix = `  ${r.packageName}@${r.pinnedVersion}`.padEnd(60, " ");
  if (r.status === "up-to-date") {
    return `✓ ${prefix} → up-to-date`;
  }
  if (r.status === "behind") {
    return `! ${prefix} → behind (latest: ${r.latestVersion ?? "unknown"})`;
  }
  return `? ${prefix} → version check failed: ${r.error ?? "unknown error"}`;
}

/**
 * Compute the exit code for the `check-mcp-versions` CI script from the
 * per-MCP results.
 *
 * - Any `behind` row → exit 1 (fail CI; humans must bump deliberately)
 * - All `fetch-failed` rows (no successes either) → exit 0 with stderr
 *   warning (don't break CI on offline runners or PyPI outages — distinguish
 *   "we are behind" from "PyPI is down")
 * - Otherwise → exit 0
 */
export function computeScriptExitCode(results: McpVersionCheckResult[]): {
  code: 0 | 1;
  warning?: string;
} {
  const anyBehind = results.some((r) => r.status === "behind");
  if (anyBehind) {
    return { code: 1 };
  }
  const allFetchFailed =
    results.length > 0 && results.every((r) => r.status === "fetch-failed");
  if (allFetchFailed) {
    return {
      code: 0,
      warning:
        "warning: every MCP version check failed — assuming offline runner / PyPI outage rather than drift. Re-run after restoring connectivity.",
    };
  }
  return { code: 0 };
}

/**
 * Run the MCP version drift check, render the report through the supplied
 * `out`/`err` sinks, and return the resulting exit code. The check function
 * is injectable so unit tests can drive it without touching the network.
 */
export async function runMcpVersionScript(
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  checkVersionsImpl: () => Promise<McpVersionCheckResult[]> = checkMcpVersions,
): Promise<0 | 1> {
  out("MCP version drift check (vs PyPI):");
  const results = await checkVersionsImpl();
  for (const r of results) {
    out(formatScriptRow(r));
  }
  const upToDate = results.filter((r) => r.status === "up-to-date").length;
  const behind = results.filter((r) => r.status === "behind").length;
  const failed = results.filter((r) => r.status === "fetch-failed").length;
  out("");
  out(
    `Summary: ${upToDate} up-to-date, ${behind} behind, ${failed} fetch-failed (${results.length} total)`,
  );

  const { code, warning } = computeScriptExitCode(results);
  if (warning) {
    err(warning);
  }
  if (code === 1) {
    err(
      "fail: at least one MCP server is behind upstream. Review release notes and bump the pin in apps/cli/src/config/mcp-servers.ts deliberately.",
    );
  }
  return code;
}

/** Single-pin check; never throws — converts errors into fetch-failed rows. */
async function checkSinglePin(pin: string): Promise<McpVersionCheckResult> {
  // Pre-declare the row identity so even a parsePin failure produces a
  // well-formed fetch-failed row instead of crashing the doctor command.
  let packageName = pin;
  let pinnedVersion = "<unknown>";
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("PyPI fetch timed out")),
    PYPI_FETCH_TIMEOUT_MS,
  );
  try {
    const parsed = parsePin(pin);
    packageName = parsed.packageName;
    pinnedVersion = parsed.pinnedVersion;
    const latestVersion = await fetchLatestVersion(
      packageName,
      controller.signal,
    );
    // compareVersions(pinned, latest):
    //   -1  → pinned < latest → we're behind (real drift, surface to humans)
    //    0  → equal           → up-to-date
    //   +1  → pinned > latest → upstream rolled back / yanked the latest
    //                            release. Treat as up-to-date because we're
    //                            holding a newer (still-shipping) build than
    //                            the registry currently advertises. Reporting
    //                            this as "behind" would be wrong AND would
    //                            cause `check-mcp-versions` CI to flap.
    const cmp = compareVersions(pinnedVersion, latestVersion);
    return {
      packageName,
      pinnedVersion,
      latestVersion,
      status: cmp < 0 ? "behind" : "up-to-date",
    };
  } catch (err) {
    return {
      packageName,
      pinnedVersion,
      latestVersion: null,
      status: "fetch-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
