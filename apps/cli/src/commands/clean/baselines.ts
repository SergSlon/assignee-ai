/**
 * --baselines scope for `assignee clean`. Runs independently of the main
 * cleanup machinery because adopted baselines are a new storage root not
 * yet represented in CleanupCategoryName / runFullCleanup.
 *
 * Wave-6d F4: split from clean.ts (A3 follow-up).
 */
export async function cleanBaselines(dryRun: boolean): Promise<void> {
  const { BASELINES_DIR } = await import("../../config/constants.js");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const baselineDir = path.resolve(process.cwd(), BASELINES_DIR);
  let files: string[] = [];
  try {
    files = await fs.readdir(baselineDir);
  } catch {
    process.stdout.write("No baseline files found (nothing to clean).\n");
    return;
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) {
    process.stdout.write("No baseline files found (nothing to clean).\n");
    return;
  }
  if (dryRun) {
    process.stdout.write(
      `Would remove ${jsonFiles.length} baseline file${jsonFiles.length === 1 ? "" : "s"} from ${baselineDir}:\n`,
    );
    for (const f of jsonFiles) process.stdout.write(`  ${f}\n`);
    process.stdout.write("\nRe-run with --confirm to delete.\n");
    return;
  }
  for (const f of jsonFiles) {
    await fs.unlink(path.join(baselineDir, f)).catch(() => {});
  }
  process.stdout.write(
    `Removed ${jsonFiles.length} baseline file${jsonFiles.length === 1 ? "" : "s"} from ${baselineDir}.\n`,
  );
}
