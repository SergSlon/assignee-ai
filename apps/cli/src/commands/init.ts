/**
 * `assignee init` command — optional project-level or global config setup.
 *
 * Without flags: creates `.assignee/config.yaml` in the current project.
 * With `--global`: creates `~/.config/assignee/config.yaml` for user-wide defaults.
 *
 * Auto-detects AWS credentials and region, prompts for confirmation,
 * and writes the config file. The command is entirely optional.
 *
 * Wave-6c F2: decomposed into `init/` sub-modules. This file is now a thin
 * Commander wrapper + re-exports for back-compat with plan/apply/setup and
 * with existing tests that dynamic-import from `./init.js`.
 *
 * Epic 92 u.d: added `--yes` / `--region <r>` / `--auto-fix <mode>` flags
 * plus non-TTY detection for CI scriptability (D-05 code-emit half / D-06 /
 * D-39 / D-45). Interactive TTY path is unchanged — when any of the new
 * flags are supplied, or when stdout is non-TTY with `--yes`, the
 * corresponding prompts are skipped and the supplied value (or a safe
 * default) is used instead.
 *
 * @see Story 18.1, ADR-010, Story 27.5, Story e92-u.d
 */

import { Command, InvalidArgumentError } from "commander";
import * as clack from "@clack/prompts";
import { AutoFixMode } from "@assignee/core";
import type { AutoFixModeType } from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  resolveIntroContext,
  formatIntroContext,
} from "./init/intro-context.js";
import { runGlobalInit } from "./init/global-flow.js";
import { runProjectInit } from "./init/project-flow.js";

// ── Re-exports for back-compat (tests + other commands) ────────────────
export {
  resolveIntroContext,
  formatIntroContext,
} from "./init/intro-context.js";
export { detectAvailableRoles } from "./init/credentials-detect.js";
export { promptGlobalConfig } from "./init/global-wizard.js";
export type { ProjectConfig } from "./init/project-config-types.js";

// ── Flag validation (Epic 92 u.d / D-45) ───────────────────────────────
const AUTO_FIX_VALUES: readonly AutoFixModeType[] = [
  AutoFixMode.ASK,
  AutoFixMode.APPLY,
  AutoFixMode.SKIP,
];

function parseAutoFixFlag(raw: string): AutoFixModeType {
  const normalized = raw.toLowerCase() as AutoFixModeType;
  if (!AUTO_FIX_VALUES.includes(normalized)) {
    throw new InvalidArgumentError(
      `--auto-fix must be one of: ${AUTO_FIX_VALUES.join(" | ")} (got "${raw}")`,
    );
  }
  return normalized;
}

/**
 * Non-TTY detection — Epic 94 R6 (D-01 regression fix).
 *
 * Node reports `process.std{in,out}.isTTY` as `undefined` (NOT `false`)
 * for streams that are pipes or redirections — e.g. the canonical CI
 * invocation `assignee init </dev/null` has `stdin.isTTY === undefined`,
 * and `assignee init | tee log.txt` has `stdout.isTTY === undefined`.
 * The previous `=== false` check missed both cases, so the D-39
 * guard-and-exit envelope never fired; clack's prompt saw a non-TTY
 * stdin, resolved immediately, and the CLI exited 0 without writing a
 * config. Every non-interactive `assignee init` without `--yes` was
 * silently broken since Epic 92 u.d landed.
 *
 * The fix: require BOTH stdin AND stdout to be an explicit TTY
 * (`isTTY === true`) for the interactive wizard to proceed. If either
 * stream is anything other than `true` (i.e. `false` OR `undefined`),
 * we treat the context as non-interactive. Stdin matters because
 * clack's prompt reads from it; stdout matters because clack's renderer
 * writes to it. Both must be a terminal for an interactive prompt to
 * make sense.
 *
 * The vitest harness tests that want to exercise the TTY branch
 * explicitly set `isTTY = true` on the relevant stream, so the
 * `!== true` check is also correct under test.
 */
function isNonInteractive(): boolean {
  return process.stdout.isTTY !== true || process.stdin.isTTY !== true;
}

interface InitOptions {
  global?: boolean;
  yes?: boolean;
  region?: string;
  autoFix?: AutoFixModeType;
}

export const initCommand = new Command(CommandName.INIT)
  .description(CommandDescription.INIT)
  .option(
    "--global",
    "Create global user config (~/.config/assignee/config.yaml) instead of project config",
  )
  .option(
    "-y, --yes",
    "Skip interactive prompts and accept defaults (CI scriptability)",
  )
  .option(
    "--region <region>",
    "AWS region to write into the config (skips the region prompt)",
  )
  .option(
    "--auto-fix <mode>",
    "Set preferences.auto_fix mode: ask | apply | skip (skips the auto-fix prompt)",
    parseAutoFixFlag,
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee init
        Create a project config in .assignee/ (interactive, asks auto-fix mode)
  $ assignee init --global
        Create/update ~/.config/assignee/config.yaml for the current user
  $ assignee init --yes --region us-east-1 --auto-fix ask
        Non-interactive, CI-friendly: skip all prompts, use supplied values

The wizard offers three auto-fix modes (ask / apply / skip) that persist
to preferences.auto_fix and control how \`assignee plan\` reacts to best
-practice findings. Re-run \`assignee init\` to change the mode later.
`,
  )
  .action(async (options: InitOptions) => {
    const isGlobal = options.global === true;

    // D-39: non-TTY detection. If stdout is not a TTY and the user did
    // not supply --yes, any prompt would block indefinitely. Fail fast
    // with an actionable error so CI pipes see the failure immediately.
    if (isNonInteractive() && options.yes !== true) {
      const region = options.region ?? "<region>";
      const autoFix = options.autoFix ?? AutoFixMode.ASK;
      process.stderr.write(
        "[ERROR] init requires a TTY OR --yes flag\n" +
          `[FIX] Re-run with: assignee init --yes --region ${region} --auto-fix ${autoFix}\n`,
      );
      process.exit(1);
      return;
    }

    const introCtx = await resolveIntroContext();
    clack.intro(
      (isGlobal
        ? "Assignee.ai — Global User Config Setup"
        : "Assignee.ai — Project Initialization") +
        `  [${formatIntroContext(introCtx)}]`,
    );

    const overrides = {
      yes: options.yes === true,
      region: options.region,
      autoFix: options.autoFix,
    };

    if (isGlobal) {
      await runGlobalInit(overrides);
      return;
    }

    await runProjectInit(overrides);
  });
