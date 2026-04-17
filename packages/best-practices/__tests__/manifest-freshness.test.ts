/**
 * Manifest integrity CI gate — asserts the on-disk `manifest.json`
 * hash matches the SHA-256 computed from the live BP YAML tree.
 *
 * If this test fails, a contributor added / edited / renamed a BP rule
 * without regenerating the manifest:
 *
 *   pnpm --filter=@assignee/best-practices run generate-manifest
 *
 * Story 50-10: wires manifest freshness into `pnpm test` so PRs that
 * land rule changes without a matching manifest bump fail in CI instead
 * of at consumer runtime.
 *
 * @see scripts/validate.ts — the contributor-facing CLI equivalent
 * @see CONTRIBUTING.md § "Contributing a Best-Practice Rule"
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { computeManifest, type BPManifest } from "../src/integrity.js";

const BASE_DIR = join(__dirname, "..");
const MANIFEST_PATH = join(BASE_DIR, "manifest.json");

describe("BP manifest freshness (Story 50-10)", () => {
  it("manifest.json exists on disk", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it("on-disk manifest.json hash matches the computed hash", () => {
    const onDisk = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf-8"),
    ) as BPManifest;
    const fresh = computeManifest(BASE_DIR);

    // If this assertion fails, regenerate the manifest:
    //   pnpm --filter=@assignee/best-practices run generate-manifest
    // and commit the updated manifest.json.
    expect(onDisk.hash).toBe(fresh.hash);
    expect(onDisk.count).toBe(fresh.count);
  });

  it("manifest.json is parseable and carries every file listed by the walker", () => {
    const onDisk = JSON.parse(
      readFileSync(MANIFEST_PATH, "utf-8"),
    ) as BPManifest;
    const fresh = computeManifest(BASE_DIR);
    const onDiskFiles = Object.keys(onDisk.files).sort();
    const freshFiles = Object.keys(fresh.files).sort();
    expect(onDiskFiles).toEqual(freshFiles);
  });
});
