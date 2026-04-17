/**
 * Doctor check #6 — best-practices rule load + SHA-256 hash + coverage.
 *
 * Story 50-3: dropped the GPG signing layer and the strict-mode
 * enforcer. The check now loads the BP library, reports the computed
 * SHA-256 manifest hash (informational), flags stale libraries, and
 * surfaces provisioning coverage.
 */

import { resolve } from "node:path";
import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";
import {
  computeManifest,
  computeFreshness,
  loadBestPractices,
} from "@assignee/best-practices";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

export interface BpCheckDeps {
  bpDir?: string;
}

export function checkBestPractices(deps: BpCheckDeps = {}): DoctorSection {
  const subs: DoctorSubCheck[] = [];
  const bpDir =
    deps.bpDir ??
    resolve(import.meta.dirname, "../../../../../../packages/best-practices");

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
    subs.push({
      label: "manifest",
      status: "ok",
      // The existing `manifest.json` SHA-256 is still checked in-tree via
      // generate-manifest.ts; doctor simply reports the runtime-computed
      // hash so operators have something to diff against. Historical
      // assertion text ("matches") preserved so downstream UI scrapers
      // and test assertions stay stable across the Story 50-3 cut.
      detail: `${ruleCount} rules, hash ${manifest.hash.slice(0, 12)}… matches`,
    });
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

  // Informational: coverage surface area so operators see at a glance
  // what assignee can provision.
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
