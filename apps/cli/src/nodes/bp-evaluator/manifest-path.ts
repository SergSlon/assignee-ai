/**
 * BP manifest path resolver.
 *
 * Resolves manifest.json across install layouts:
 *   - Monorepo dev (apps/cli/src/nodes/)
 *   - Monorepo dist (apps/cli/dist/nodes/)
 *   - Installed (node_modules/@assignee/best-practices/)
 *
 * L5 V1 audit (2026-04-06): every candidate is path.normalize()d so
 * `..` segments collapse predictably across platforms.
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { log, LOG_ACTIONS } from "../../utils/logger.js";

/**
 * Build the list of normalized candidate paths for the BP manifest.
 * Exported so the L5 audit regression test can assert every entry collapses
 * through `path.normalize` and stays within a sane filesystem boundary.
 */
export function _listBpManifestCandidates(dirname: string): string[] {
  return [
    path.normalize(
      path.join(
        dirname,
        "..",
        "..",
        "..",
        "..",
        "packages",
        "best-practices",
        "manifest.json",
      ),
    ),
    path.normalize(
      path.join(
        dirname,
        "..",
        "..",
        "..",
        "packages",
        "best-practices",
        "manifest.json",
      ),
    ),
    path.normalize(
      path.join(
        dirname,
        "..",
        "..",
        "..",
        "@assignee",
        "best-practices",
        "manifest.json",
      ),
    ),
  ];
}

/**
 * Resolve the BP manifest path across install layouts.
 * Returns the first path that exists, or the first candidate if none do
 * (which causes `verifyManifest` to enter trust-on-first-use mode).
 */
export function resolveBpManifestPath(): string {
  const dirname = import.meta.dirname ?? process.cwd();
  const candidates: string[] = _listBpManifestCandidates(dirname);

  try {
    const req = createRequire(import.meta.url);
    const resolved = path.normalize(
      req.resolve("@assignee/best-practices/manifest.json"),
    );
    candidates.unshift(resolved);
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
      extras: {
        phase: "manifest_resolve_via_require",
        error: String(err),
      },
    });
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "info",
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
        extras: {
          phase: "manifest_candidate_stat",
          candidate,
          error: String(err),
        },
      });
    }
  }
  return candidates[0]!;
}
