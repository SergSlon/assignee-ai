#!/usr/bin/env node
/**
 * wizard-audit — regression harness for the assignee wizard UX.
 *
 * Drives `node apps/cli/dist/index.js <wizard-command>` through the
 * checked-in PTY driver (apps/cli/scripts/pty-driver.py), captures the
 * screen-by-screen output, sanitises non-deterministic bits, and diffs
 * the result against a golden snapshot under
 * `apps/cli/__fixtures__/wizard-snapshots/`.
 *
 * The harness is the regression-suite incarnation of the 2026-05-22
 * wizard UX audit (see `_backlog/wizard-ux-audit-2026-05-22.md`). Any
 * accidental change to a wizard's prompt order, banner wording,
 * placeholder text, or finalisation summary will surface as a diff.
 *
 * Hard constraints baked into the case set:
 *
 *   1. NO Bedrock calls. `infra plan --wizard` is deliberately excluded
 *      (the audit paid ~$0.013/call; not viable to eat on every CI run).
 *   2. NO live AWS calls. Cases that would normally call CloudControl /
 *      IAM / Pricing run inside a fresh tmp HOME with empty AWS env
 *      vars so the wizard exercises only the local prompt logic.
 *
 * Usage:
 *
 *   pnpm wizard-audit            # diff against goldens, exit 1 on drift
 *   pnpm wizard-audit --update   # refresh goldens (commit the diff)
 *   pnpm wizard-audit --filter dev-init-wizard   # run a single case
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md#regression-suite-landed-2026-05-23
 * @see apps/cli/scripts/pty-driver.py — the underlying PTY driver
 * @see apps/cli/__fixtures__/wizard-snapshots/ — the golden files
 */

import { rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PKG = resolve(__dirname, "..");
const CLI_DIST = join(CLI_PKG, "dist", "index.js");
const PTY_DRIVER = join(__dirname, "pty-driver.py");
const SNAPSHOT_DIR = join(CLI_PKG, "__fixtures__", "wizard-snapshots");

const CASES = [
  {
    name: "dev-init-wizard",
    description:
      "`assignee dev init --wizard` in a fresh project — exercises 4-prompt project wizard.",
    args: ["dev", "init", "--wizard"],
  },
  {
    name: "dev-init-global-wizard",
    description:
      "`assignee dev init --global --wizard` against a fresh HOME — exercises 4-prompt global wizard.",
    args: ["dev", "init", "--global", "--wizard"],
  },
];

const TIMEOUT_MS = 60_000;

/**
 * Strip per-run non-determinism from captured PTY output.
 *
 * The PTY driver already removes ANSI escapes and collapses spinner
 * frames; this pass replaces filesystem paths, env-dependent regions,
 * and other run-specific tokens with stable placeholders so the diff
 * surfaces only behavioural drift.
 */
function sanitise(text, { tmpHome, projectDir }) {
  let out = text;
  // Replace the tmp HOME path and project dir with stable placeholders.
  // ORDER MATTERS for path replacement: when projectDir lives inside
  // tmpHome (true on every OS), the longer path MUST be substituted
  // first or the shorter prefix swallows it.
  //   project (raw)             → <TMP_PROJECT>
  //   project (/private/var)    → <TMP_PROJECT>  (Mac symlink form)
  //   home    (raw)             → <TMP_HOME>
  //   home    (/private/var)    → <TMP_HOME>     (Mac symlink form)
  // On Linux the `/private/var` replacements are no-ops (replaceAll
  // with a literal that isn't present), so the order is harmless.
  out = out.replaceAll(projectDir, "<TMP_PROJECT>");
  out = out.replaceAll(
    projectDir.replace(/^\/var\//, "/private/var/"),
    "<TMP_PROJECT>",
  );
  out = out.replaceAll(tmpHome, "<TMP_HOME>");
  out = out.replaceAll(
    tmpHome.replace(/^\/var\//, "/private/var/"),
    "<TMP_HOME>",
  );
  // CLI version string in the banner — bumps every release and isn't a
  // UX regression on its own.
  out = out.replace(/v\d+\.\d+\.\d+(-[\w.]+)?/g, "v<VERSION>");
  // Wall-clock timestamps the wizard may print on summary screens
  // (ISO-8601 with timezone offset).
  out = out.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g,
    "<TIMESTAMP>",
  );
  return out;
}

function buildEnv(tmpHome) {
  const env = { ...process.env };
  // Wipe every env key whose presence is known to mutate wizard
  // output. Two families: AWS_* (auth surface — keeps the wizard on
  // the local-config path and prevents accidental API calls) and
  // ASSIGNEE_* (the repo's ~80-var contributor surface — operator
  // keys feed the "Assignee roles available: …" line, OIDC_ADAPTER
  // feeds the OIDC status line, AUTO_FIX could pre-select a radio,
  // etc.). A contributor with any of these set in their shell would
  // otherwise produce a different capture than CI does.
  for (const key of Object.keys(env)) {
    if (key.startsWith("AWS_") || key.startsWith("ASSIGNEE_")) {
      delete env[key];
    }
  }
  env.HOME = tmpHome;
  env.AWS_REGION = "us-east-1";
  env.NO_COLOR = "1";
  env.CI = "1";
  // Force a deterministic terminal size — pty-driver also sets winsize
  // but some clack widgets read TERM-derived width hints.
  env.COLUMNS = "120";
  env.LINES = "40";
  // Pin locale so error/warning text formatting doesn't drift by
  // contributor shell — some CLI strings flow through Intl helpers
  // that vary by LANG/LC_ALL.
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  return env;
}

/**
 * Run the PTY driver against one case, return the sanitised capture.
 */
async function runCase(testCase) {
  const tmpHomeBase = await mkdtemp(join(tmpdir(), "wizard-audit-home-"));
  const projectDir = join(tmpHomeBase, "project");
  await mkdir(projectDir, { recursive: true });

  const env = buildEnv(tmpHomeBase);

  return new Promise((resolveCase, rejectCase) => {
    const child = spawn(
      "python3",
      [PTY_DRIVER, "node", CLI_DIST, ...testCase.args],
      {
        cwd: projectDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const cleanupTmpHome = () => {
      try {
        rmSync(tmpHomeBase, { recursive: true, force: true });
      } catch {
        // ignore — /tmp gets purged on reboot anyway
      }
    };
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      cleanupTmpHome();
      rejectCase(
        new Error(`Case '${testCase.name}' timed out after ${TIMEOUT_MS}ms`),
      );
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      cleanupTmpHome();
      const sanitised = sanitise(stdout, {
        tmpHome: tmpHomeBase,
        projectDir,
      });
      resolveCase({ code, stdout: sanitised, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(killer);
      cleanupTmpHome();
      rejectCase(err);
    });
  });
}

/**
 * Minimal unified-diff between two strings (line-by-line). Good
 * enough for human inspection; not RFC-compliant.
 */
function unifiedDiff(expected, actual, name) {
  const exp = expected.split("\n");
  const act = actual.split("\n");
  const max = Math.max(exp.length, act.length);
  const lines = [];
  for (let i = 0; i < max; i += 1) {
    if (exp[i] === act[i]) continue;
    if (exp[i] !== undefined) lines.push(`-${exp[i]}`);
    if (act[i] !== undefined) lines.push(`+${act[i]}`);
  }
  return `--- ${name} (golden)\n+++ ${name} (actual)\n${lines.join("\n")}\n`;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const updateMode = argv.includes("--update");
  const filterIdx = argv.indexOf("--filter");
  if (filterIdx >= 0 && filterIdx === argv.length - 1) {
    console.error("wizard-audit: --filter requires a case name.");
    process.exit(2);
  }
  const filter = filterIdx >= 0 ? argv[filterIdx + 1] : undefined;

  if (!(await fileExists(CLI_DIST))) {
    console.error(
      `wizard-audit: CLI dist not found at ${CLI_DIST}. Run \`pnpm build\` first.`,
    );
    process.exit(2);
  }
  if (!(await fileExists(PTY_DRIVER))) {
    console.error(`wizard-audit: PTY driver missing at ${PTY_DRIVER}.`);
    process.exit(2);
  }

  await mkdir(SNAPSHOT_DIR, { recursive: true });

  const selected = filter
    ? CASES.filter((c) => c.name === filter)
    : CASES;
  if (filter && selected.length === 0) {
    console.error(`wizard-audit: no case named '${filter}'.`);
    process.exit(2);
  }

  let drift = 0;
  let updated = 0;
  for (const testCase of selected) {
    process.stdout.write(`[wizard-audit] ${testCase.name} … `);
    let result;
    try {
      result = await runCase(testCase);
    } catch (err) {
      console.log(`ERROR\n  ${err.message}`);
      drift += 1;
      continue;
    }
    // Catch crashed/incomplete captures: pty-driver always writes
    // "[driver] exit code: N" as its last line. Missing line OR
    // non-zero exit means the child died unexpectedly — surface as
    // an error rather than silently capturing a partial snapshot
    // under --update.
    const droveCleanly =
      result.code === 0 && /\[driver\] exit code: 0\n?$/.test(result.stdout);
    if (!droveCleanly) {
      console.log("ERROR");
      console.log(
        `  python3 child exited with code=${result.code}; capture may be incomplete.`,
      );
      if (result.stderr) {
        console.log(`  stderr (truncated to 400 chars): ${result.stderr.slice(0, 400)}`);
      }
      drift += 1;
      continue;
    }
    const goldenPath = join(SNAPSHOT_DIR, `${testCase.name}.snapshot.txt`);
    const actual = result.stdout;
    const exists = await fileExists(goldenPath);

    if (updateMode || !exists) {
      await writeFile(goldenPath, actual, "utf8");
      console.log(exists ? "UPDATED" : "CREATED");
      updated += 1;
      continue;
    }

    const expected = await readFile(goldenPath, "utf8");
    if (expected === actual) {
      console.log("OK");
      continue;
    }
    console.log("DRIFT");
    drift += 1;
    console.log(unifiedDiff(expected, actual, testCase.name));
  }

  if (updateMode) {
    console.log(
      `\nwizard-audit: ${updated} snapshot(s) written.${
        drift ? ` ${drift} case(s) failed during capture.` : ""
      }`,
    );
    process.exit(drift > 0 ? 1 : 0);
  }
  if (drift > 0) {
    console.log(
      `\nwizard-audit: ${drift} snapshot(s) drifted. Run \`pnpm wizard-audit --update\` after intentional changes.`,
    );
    process.exit(1);
  }
  console.log(`\nwizard-audit: ${selected.length} case(s) match the golden.`);
}

main().catch((err) => {
  console.error("wizard-audit: fatal", err);
  process.exit(2);
});
