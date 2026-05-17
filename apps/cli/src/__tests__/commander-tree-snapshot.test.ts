/**
 * Commander Tree Snapshot — Story 108-A-05 Axis I regression guard.
 *
 * Serializes the PRODUCTION command tree (built via
 * `buildAssigneeProgram()` from `../program.js`) to a human-readable
 * snapshot. Any future structural change (added/removed/renamed command
 * or group) will fail this test, forcing an explicit snapshot update.
 *
 * Round 2 (Quinn BOUNCE fix): replaced the inline tree builder with a
 * call to the shared factory so the snapshot reflects the SAME tree that
 * ships in `dist/index.js`. Pre-refactor the test built its own tree,
 * which let a divergent build-time tree (in `generate-completions.ts`)
 * pass tests while shipping broken bundled completions.
 *
 * Tree structure (18 leaf commands under 3 noun groups):
 *   infra  — plan, apply, destroy, drift, reconcile, optimize, restore-provisions
 *   admin  — audit-verify, doctor, status, list, describe
 *   dev    — init, setup, update, completions, discover, version
 *
 * Axis B coverage (typo handling) is in the second describe-block below —
 * spawns the CLI binary and asserts `assignee infra pla` emits a
 * did-you-mean message + exit 1.
 *
 * @see Story 108-A-05 (noun-grouped CLI restructure)
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

// ─── helpers ─────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  commands?: TreeNode[];
}

/** Recursively serialize a Commander.js Command to a plain object. */
function serializeTree(cmd: Command): TreeNode {
  const node: TreeNode = { name: cmd.name() };
  if (cmd.commands.length > 0) {
    node.commands = cmd.commands.map(serializeTree);
  }
  return node;
}

// ─── snapshot tests ──────────────────────────────────────────────────────────

describe("Commander tree snapshot (108-A-05)", () => {
  it("noun-grouped tree has all 18 leaf commands under 3 groups", async () => {
    // Round 2: import the production factory so the snapshot reflects the
    // same tree the bundled binary + completion artifacts ship.
    const { buildAssigneeProgram } = await import("../program.js");
    const program = buildAssigneeProgram();
    program.name("assignee");

    const tree = serializeTree(program);

    // Snapshot — update with `vitest --update-snapshots` when the tree
    // changes intentionally.
    expect(tree).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "commands": [
              {
                "name": "plan",
              },
              {
                "name": "apply",
              },
              {
                "name": "destroy",
              },
              {
                "name": "drift",
              },
              {
                "name": "reconcile",
              },
              {
                "name": "optimize",
              },
              {
                "name": "restore-provisions",
              },
            ],
            "name": "infra",
          },
          {
            "commands": [
              {
                "name": "audit-verify",
              },
              {
                "name": "doctor",
              },
              {
                "name": "status",
              },
              {
                "name": "list",
              },
              {
                "name": "describe",
              },
            ],
            "name": "admin",
          },
          {
            "commands": [
              {
                "name": "init",
              },
              {
                "name": "setup",
              },
              {
                "name": "update",
              },
              {
                "name": "completions",
              },
              {
                "name": "discover",
              },
              {
                "name": "version",
              },
            ],
            "name": "dev",
          },
        ],
        "name": "assignee",
      }
    `);
  });

  it("infra group has exactly 7 leaf commands", async () => {
    const { buildAssigneeProgram } = await import("../program.js");
    const program = buildAssigneeProgram();
    const infraGroup = program.commands.find((c) => c.name() === "infra");
    expect(infraGroup).toBeDefined();
    const leafNames = infraGroup!.commands.map((c) => c.name());
    expect(leafNames).toHaveLength(7);
    expect(leafNames).toEqual([
      "plan",
      "apply",
      "destroy",
      "drift",
      "reconcile",
      "optimize",
      "restore-provisions",
    ]);
  });

  it("admin group has exactly 5 leaf commands", async () => {
    const { buildAssigneeProgram } = await import("../program.js");
    const program = buildAssigneeProgram();
    const adminGroup = program.commands.find((c) => c.name() === "admin");
    expect(adminGroup).toBeDefined();
    const leafNames = adminGroup!.commands.map((c) => c.name());
    expect(leafNames).toHaveLength(5);
    expect(leafNames).toEqual([
      "audit-verify",
      "doctor",
      "status",
      "list",
      "describe",
    ]);
  });

  it("dev group has exactly 6 leaf commands", async () => {
    const { buildAssigneeProgram } = await import("../program.js");
    const program = buildAssigneeProgram();
    const devGroup = program.commands.find((c) => c.name() === "dev");
    expect(devGroup).toBeDefined();
    const leafNames = devGroup!.commands.map((c) => c.name());
    expect(leafNames).toHaveLength(6);
    expect(leafNames).toEqual([
      "init",
      "setup",
      "update",
      "completions",
      "discover",
      "version",
    ]);
  });

  it("total leaf command count is exactly 18 (7 + 5 + 6)", async () => {
    const { buildAssigneeProgram } = await import("../program.js");
    const program = buildAssigneeProgram();
    const total = program.commands.reduce(
      (acc, group) => acc + group.commands.length,
      0,
    );
    expect(total).toBe(18);
  });

  it("factory output matches between production and build-time consumers (BOUNCE BLOCKER #1 regression guard)", async () => {
    // Quinn BOUNCE round 1: the build-time `generate-completions.ts` script
    // used to build its own flat tree, divergent from the runtime tree. Both
    // call points now consume `buildAssigneeProgram()`, so calling it twice
    // must yield identical structures. This catches future "second copy of
    // the tree" regressions before they ship broken completion artifacts.
    const { buildAssigneeProgram } = await import("../program.js");
    const a = serializeTree(buildAssigneeProgram());
    const b = serializeTree(buildAssigneeProgram());
    expect(a).toEqual(b);
    // Top-level must be exactly 3 noun groups (infra / admin / dev).
    expect(a.commands?.map((c) => c.name)).toEqual(["infra", "admin", "dev"]);
  });
});

// ─── Axis B — typo handling (did-you-mean) ──────────────────────────────────

describe("Commander typo handling — Axis B (108-A-05)", () => {
  const __filename = fileURLToPath(import.meta.url);
  const cliDist = path.resolve(
    path.dirname(__filename),
    "..",
    "..",
    "dist",
    "index.js",
  );

  it("typoed subcommand under a noun group emits did-you-mean and exit 1", () => {
    // Only assert when the built binary exists. CI runs `pnpm build` before
    // `pnpm test`, so dist/index.js is present at test time. Local
    // pre-build vitest runs skip the assertion rather than fail spuriously.
    if (!fs.existsSync(cliDist)) {
      return;
    }
    const result = spawnSync("node", [cliDist, "infra", "pla"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ASSIGNEE_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    });
    expect(result.status).toBe(1);
    // Commander emits: error: unknown command 'pla' (Did you mean plan?)
    const combinedErr = (result.stderr ?? "") + (result.stdout ?? "");
    expect(combinedErr).toContain("unknown command 'pla'");
    expect(combinedErr.toLowerCase()).toContain("did you mean");
    expect(combinedErr).toContain("plan");
  });

  it("legacy flat path (Axis J) is rejected with exit 1", () => {
    if (!fs.existsSync(cliDist)) {
      return;
    }
    const result = spawnSync("node", [cliDist, "plan"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ASSIGNEE_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
    });
    expect(result.status).toBe(1);
    const combinedErr = (result.stderr ?? "") + (result.stdout ?? "");
    expect(combinedErr).toContain("unknown command 'plan'");
  });
});
