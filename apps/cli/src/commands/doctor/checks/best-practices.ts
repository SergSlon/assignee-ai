/**
 * Doctor check #6 — best-practices manifest integrity + coverage.
 *
 * Verifies the BP library against its committed manifest, counts rules,
 * and surfaces freshness. A hash mismatch means a BP file was edited
 * without rebuilding the manifest.
 */

import { join, resolve } from "node:path";
import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";
import {
  computeManifest,
  verifyManifest,
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
