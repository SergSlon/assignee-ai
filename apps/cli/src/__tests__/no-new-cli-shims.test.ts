/**
 * Tests for `apps/cli/scripts/no-new-cli-shims.mjs` — Story 56-it2-01
 * (closes it56-1-L4-007a).
 *
 * Verifies:
 *   1. The current tree's shim set matches the snapshot exactly
 *      (drift-guard) — guarantees the snapshot stays in sync with
 *      reality and that this story's baseline is honest.
 *   2. `diffShims()` flags a NEW shim path (policy violation).
 *   3. `diffShims()` flags a REMOVED shim path (snapshot-stale).
 *   4. `scanShims()` picks up a real shim comment from a temp file.
 *
 * We import the pure helpers directly from the mjs so no child process
 * or temp repo layout is needed.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanShims,
  loadSnapshot,
  diffShims,
  CLI_SRC,
  FIXTURE,
} from "../../scripts/no-new-cli-shims.mjs";

describe("no-new-cli-shims linter", () => {
  it("snapshot matches live tree (no drift)", async () => {
    const current = await scanShims(CLI_SRC);
    const snapshot = await loadSnapshot(FIXTURE);
    const { added, removed } = diffShims(current, snapshot);
    // Real drift messages are more useful than a generic failure so if
    // this fails contributors see the actual new/removed files.
    expect(
      { added, removed },
      `Shim snapshot drifted. Regenerate via \`node apps/cli/scripts/no-new-cli-shims.mjs --write\` ` +
        `after confirming each new shim is intentional.`,
    ).toEqual({ added: [], removed: [] });
  });

  it("diffShims reports a NEW shim as added (policy violation)", () => {
    const snapshot = [
      "utils/display.ts",
      "utils/free-tier.ts",
      "utils/timeout.ts",
    ];
    const current = [
      "utils/display.ts",
      "utils/free-tier.ts",
      "utils/new-thing.ts", // NEW — simulates forbidden shim addition
      "utils/timeout.ts",
    ];
    const { added, removed } = diffShims(current, snapshot);
    expect(added).toEqual(["utils/new-thing.ts"]);
    expect(removed).toEqual([]);
  });

  it("diffShims reports a DELETED shim as removed (snapshot-stale)", () => {
    const snapshot = [
      "utils/display.ts",
      "utils/free-tier.ts",
      "utils/timeout.ts",
    ];
    const current = [
      "utils/display.ts",
      // utils/free-tier.ts deleted on purpose
      "utils/timeout.ts",
    ];
    const { added, removed } = diffShims(current, snapshot);
    expect(added).toEqual([]);
    expect(removed).toEqual(["utils/free-tier.ts"]);
  });

  it("scanShims detects a shim via docblock marker", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "shim-scan-"));
    const utilsDir = join(tmpRoot, "utils");
    await mkdir(utilsDir, { recursive: true });
    // Realistic shim body — matches the real pattern used across
    // 62 CLI shims (apps/cli/src/utils/display.ts et al).
    const shimBody =
      `/**\n` +
      ` * Thin re-export shim — implementation moved to @assignee/core.\n` +
      ` */\n` +
      `export { something } from "@assignee/core";\n`;
    await writeFile(join(utilsDir, "display.ts"), shimBody, "utf8");
    // Non-shim sibling — regular file WITHOUT the marker comment.
    await writeFile(
      join(utilsDir, "regular.ts"),
      `export function realWork() { return 42; }\n`,
      "utf8",
    );
    // Alternate shim marker — also recognised.
    await writeFile(
      join(utilsDir, "alt.ts"),
      `// Re-export from @assignee/core — legacy stability shim.\n` +
        `export { thing } from "@assignee/core";\n`,
      "utf8",
    );
    // .test.ts sibling — must be skipped even if it matches.
    await writeFile(
      join(utilsDir, "display.test.ts"),
      `// Thin re-export shim — fake marker inside a test file.\n`,
      "utf8",
    );

    const hits = await scanShims(tmpRoot);
    expect(hits).toEqual(["utils/alt.ts", "utils/display.ts"]);
  });
});
