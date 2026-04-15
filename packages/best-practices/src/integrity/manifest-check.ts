/**
 * Manifest computation + freshness stats for the BP library.
 *
 * Split from integrity.ts (W6d F3). Owns the directory walk, per-file
 * hashing, and the `BPManifest`/`BPFreshness` shapes.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SKIP_DIRS } from "../loader.js";

/** Freshness status for the BP library. */
export interface BPFreshness {
  /** ISO string of the oldest file modification time in the library. */
  oldestFileDate: string;
  /** Age of the oldest file in days. */
  oldestAgeDays: number;
  /** Total count of BP YAML files. */
  fileCount: number;
  /** True when oldest file is > stale threshold (default 180 days). */
  isStale: boolean;
  /** Threshold in days that triggered `isStale`. */
  staleThresholdDays: number;
}

/** SHA-256 integrity manifest for the BP library. */
export interface BPManifest {
  /** Version of the manifest format. */
  version: 1;
  /** Overall SHA-256 hash of the sorted per-file hashes. */
  hash: string;
  /** Per-file SHA-256 hashes, keyed by relative path. */
  files: Record<string, string>;
  /** Total count of files in the manifest. */
  count: number;
  /** ISO timestamp when the manifest was generated. */
  generatedAt: string;
}

/** Default staleness threshold: 180 days (~6 months). */
export const DEFAULT_STALE_THRESHOLD_DAYS = 180;

/**
 * Walk the BP directory and collect per-file metadata (mtime + sha256).
 * Mirrors loader.ts walking logic.
 */
export function walkBpFiles(
  baseDir: string,
): Array<{ relPath: string; mtime: number; sha256: string }> {
  const files: Array<{ relPath: string; mtime: number; sha256: string }> = [];

  for (const entry of readdirSync(baseDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const entryPath = join(baseDir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = join(entryPath, file);
      // TOCTOU-safe: a file listed by readdirSync can be removed before we
      // stat/read it (e.g. concurrent rule reload, atomic rewrite). On
      // ENOENT skip silently — the next walk will pick it up. On any
      // other error log a warning and continue rather than aborting the
      // entire walk and tearing down BP integrity.
      try {
        const stat = statSync(filePath);
        const content = readFileSync(filePath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        files.push({
          relPath: `${entry}/${file}`,
          mtime: stat.mtimeMs,
          sha256,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // Race with concurrent delete — silently skip.
          continue;
        }
        process.stderr.write(
          `[bp-integrity] warn: failed to read ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  }

  // Sort by relPath for deterministic manifest ordering
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

/**
 * Compute freshness stats for the BP library.
 *
 * @param baseDir - Base directory containing service subdirectories. Defaults to the loader's base.
 * @param staleThresholdDays - Age in days after which the library is considered stale.
 */
export function computeFreshness(
  baseDir?: string,
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): BPFreshness {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const files = walkBpFiles(dir);

  if (files.length === 0) {
    return {
      oldestFileDate: new Date().toISOString(),
      oldestAgeDays: 0,
      fileCount: 0,
      isStale: false,
      staleThresholdDays,
    };
  }

  // Reduce instead of Math.min(...spread) — spreading large arrays risks
  // hitting the V8 stack-arg limit (~125k elements). reduce is unconditionally
  // safe regardless of file count.
  const oldestMtime = files.reduce(
    (min, f) => (f.mtime < min ? f.mtime : min),
    Infinity,
  );
  const ageMs = Date.now() - oldestMtime;
  const oldestAgeDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  return {
    oldestFileDate: new Date(oldestMtime).toISOString(),
    oldestAgeDays,
    fileCount: files.length,
    isStale: oldestAgeDays > staleThresholdDays,
    staleThresholdDays,
  };
}

/**
 * Compute a SHA-256 integrity manifest for the BP library at load time.
 */
export function computeManifest(baseDir?: string): BPManifest {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const files = walkBpFiles(dir);

  const perFile: Record<string, string> = {};
  for (const f of files) perFile[f.relPath] = f.sha256;

  // Overall hash = SHA-256 of the sorted "relPath:sha256" lines
  const lines = Object.entries(perFile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hash]) => `${path}:${hash}`)
    .join("\n");
  const overallHash = createHash("sha256").update(lines).digest("hex");

  return {
    version: 1,
    hash: overallHash,
    files: perFile,
    count: files.length,
    generatedAt: new Date().toISOString(),
  };
}
