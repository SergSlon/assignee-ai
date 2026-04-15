/**
 * `assignee init` command — optional project-level or global configuration setup.
 *
 * Without flags: creates `.assignee/config.yaml` in the current project.
 * With `--global`: creates `~/.config/assignee/config.yaml` for user-wide defaults.
 *
 * Auto-detects AWS credentials and region, prompts for confirmation,
 * and writes the config file. The command is entirely optional;
 * all CLI commands work without it by using the standard AWS credential chain.
 *
 * @see Story 18.1, ADR-010, Story 27.5
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import * as clack from "@clack/prompts";
import { stringify as yamlStringify } from "yaml";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  DEFAULT_AWS_REGION,
  validateConfig,
  AssigneeTag,
  AutoFixMode,
  ASSIGNEE_ROLES,
  envVarsForRole,
  type AssigneeRole,
} from "@assignee/core";
import type { AssigneeConfig } from "@assignee/core";
import {
  detectCredentials,
  detectRegion,
} from "../services/credential-detector.js";
import { resolveConfigPath } from "../config/user-config-loader.js";
import { UserMessage, CHECKPOINT_DIR, FileName } from "../config/constants.js";

/**
 * Detect which Assignee IAM roles have credentials configured via environment.
 *
 * Delegates to `@assignee/core` (envVarsForRole) for the role → env var
 * mapping so there is exactly one source of truth across the monorepo.
 *
 * Each role pair must have BOTH access key id AND secret access key set
 * (non-empty after trim) to be considered available.
 *
 * @see SECURITY-AUDIT.md — M-S8
 */
export function detectAvailableRoles(
  env: NodeJS.ProcessEnv = process.env,
): AssigneeRole[] {
  const available: AssigneeRole[] = [];
  for (const role of ASSIGNEE_ROLES) {
    const { accessKey, secretKey } = envVarsForRole(role);
    const id = env[accessKey]?.trim();
    const secret = env[secretKey]?.trim();
    if (id && secret) {
      available.push(role);
    }
  }
  return available;
}

/** Directory name for assignee project config. */
const CONFIG_DIR = CHECKPOINT_DIR;

/** Config file name inside the config directory. */
const CONFIG_FILE = FileName.CONFIG;

/** Environment options for the interactive prompt. */
const ENVIRONMENT_OPTIONS = [
  { value: "development", label: "development" },
  { value: "staging", label: "staging" },
  { value: "production", label: "production" },
] as const;

/**
 * Shape of the `.assignee/config.yaml` project config file.
 * Must be compatible with the user-config-loader.ts schema (Story 7.2).
 */
export interface ProjectConfig {
  region: string;
  profile: string;
  tags: {
    [key: string]: string;
    environment: string;
  };
  autoFixBestPractices?: boolean;
  /** Nested AssigneeConfig shape consumed by project-config-loader */
  defaults?: { region?: string; tags?: Record<string, string> };
  preferences?: {
    /** One of AutoFixMode: "ask" | "apply" | "skip". */
    auto_fix?: (typeof AutoFixMode)[keyof typeof AutoFixMode];
  };
  priceCacheTtlMinutes?: number;
}

/**
 * Prompts the user for global config values and returns an AssigneeConfig object.
 * Uses @clack/prompts for interactive input.
 *
 * @see Story 27.5 — AC #2, #6, #7
 */
export async function promptGlobalConfig(): Promise<
  AssigneeConfig | undefined
> {
  // ── Region ─────────────────────────────────────────────────────────
  const region = await clack.text({
    message: "Default AWS region",
    placeholder: DEFAULT_AWS_REGION,
  });

  if (clack.isCancel(region)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // ── Tags (multi-entry loop) ────────────────────────────────────────
  const tags: Record<string, string> = {};
  while (true) {
    const entry = await clack.text({
      message: "Add a tag (key=value), or press Enter to finish",
      placeholder: "environment=dev",
    });

    if (clack.isCancel(entry)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }

    if (!entry) break;

    const entryStr = String(entry);
    const eqIndex = entryStr.indexOf("=");
    // L-A9: Surface malformed entries instead of swallowing them silently.
    // Without a warning, users can't tell why their tag wasn't recorded.
    if (eqIndex <= 0) {
      // No `=` (eqIndex === -1) or leading `=` (eqIndex === 0 ⇒ empty key).
      clack.log.warn(
        `Ignored tag "${entryStr}" — must be in key=value format with a non-empty key.`,
      );
      continue;
    }
    const key = entryStr.slice(0, eqIndex).trim();
    const val = entryStr.slice(eqIndex + 1).trim();
    if (!key) {
      clack.log.warn(
        `Ignored tag "${entryStr}" — key is empty after trimming whitespace.`,
      );
      continue;
    }
    if (!val) {
      clack.log.warn(
        `Ignored tag "${entryStr}" — value is empty after trimming whitespace.`,
      );
      continue;
    }
    tags[key] = val;
  }

  // ── Naming prefix ──────────────────────────────────────────────────
  const prefix = await clack.text({
    message: "Resource naming prefix (optional, press Enter to skip)",
    placeholder: "mycompany-",
  });

  if (clack.isCancel(prefix)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // ── Auto-fix mode ──────────────────────────────────────────────────
  const autoFix = await clack.select({
    message: "Auto-fix best practice violations",
    options: [
      {
        value: AutoFixMode.ASK,
        label: "ask — prompt before each fix (default)",
      },
      { value: AutoFixMode.APPLY, label: "apply — fix automatically" },
      { value: AutoFixMode.SKIP, label: "skip — never auto-fix" },
    ],
    initialValue: AutoFixMode.ASK,
  });

  if (clack.isCancel(autoFix)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // ── Output format ──────────────────────────────────────────────────
  const outputFormat = await clack.select({
    message: "Output format",
    options: [
      { value: "table", label: "table — human-readable tables (default)" },
      { value: "json", label: "json — machine-readable JSON" },
    ],
    initialValue: "table",
  });

  if (clack.isCancel(outputFormat)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // ── Verbosity ──────────────────────────────────────────────────────
  const verbosity = await clack.select({
    message: "Verbosity level",
    options: [
      { value: "quiet", label: "quiet — minimal output" },
      { value: "normal", label: "normal — standard output (default)" },
      { value: "verbose", label: "verbose — detailed output" },
    ],
    initialValue: "normal",
  });

  if (clack.isCancel(verbosity)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

  // ── Assemble config ────────────────────────────────────────────────
  const config: AssigneeConfig = {
    defaults: {
      region: (region as string) || undefined,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      naming: (prefix as string) ? { prefix: prefix as string } : undefined,
    },
    preferences: {
      auto_fix: autoFix as AssigneeConfig["preferences"] extends {
        auto_fix?: infer T;
      }
        ? T
        : never,
      output_format: outputFormat as AssigneeConfig["preferences"] extends {
        output_format?: infer T;
      }
        ? T
        : never,
      verbosity: verbosity as AssigneeConfig["preferences"] extends {
        verbosity?: infer T;
      }
        ? T
        : never,
    },
  };

  // Validate before writing (sanity check)
  validateConfig(config);

  return config;
}

export const initCommand = new Command(CommandName.INIT)
  .description(CommandDescription.INIT)
  .option(
    "--global",
    "Create global user config (~/.config/assignee/config.yaml) instead of project config",
  )
  .action(async (options: { global?: boolean }) => {
    const isGlobal = options.global === true;

    clack.intro(
      isGlobal
        ? "Assignee.ai — Global User Config Setup"
        : "Assignee.ai — Project Initialization",
    );

    if (isGlobal) {
      // ── Global config path ───────────────────────────────────────────
      const configPath = resolveConfigPath();
      const configDir = path.dirname(configPath);

      // Check for existing global config
      try {
        await fs.access(configPath);
        // Item 4b (2026-04-10): surface the resolved path so the user
        // knows exactly which file they're about to overwrite — not
        // every user knows the default lives at ~/.config/assignee/.
        const overwrite = await clack.confirm({
          message: `Global config already exists at ${configPath}. Overwrite it?`,
          initialValue: false,
        });

        if (clack.isCancel(overwrite) || overwrite === false) {
          clack.outro(
            `Keeping existing configuration at ${configPath}. No changes made.`,
          );
          return;
        }
      } catch {
        // Config does not exist — proceed
      }

      // Run global config wizard
      const config = await promptGlobalConfig();
      if (!config) return;

      // Write config file
      await fs.mkdir(configDir, { recursive: true });
      const yamlContent =
        "# Generated by assignee init --global\n" + yamlStringify(config);
      await fs.writeFile(configPath, yamlContent, "utf-8");

      clack.outro(
        `Global config written to ${configPath}. Your defaults will apply to all projects.`,
      );
      return;
    }

    // ── Project-level init (original behavior, unchanged) ───────────

    // ── Credential detection (non-fatal) ──────────────────────────────
    // `assignee init` is supposed to work without credentials so users can
    // create the project config first, then run `assignee setup` (or export
    // AWS keys) afterwards. We only *report* credential state here.
    const credentialResult = await detectCredentials();
    const availableRoles = detectAvailableRoles();

    if (credentialResult.detected) {
      clack.log.success(
        `AWS credentials detected (source: ${credentialResult.source})`,
      );
      // Only print the roles-available info line when creds were detected,
      // as a positive confirmation. When no creds are detected, the warn
      // block below already conveys "no roles" — printing both stacks 3
      // info blocks with `│` connectors and reads like committee output.
      if (availableRoles.length > 0) {
        clack.log.info(
          `Assignee roles available: ${availableRoles.join(", ")}`,
        );
      } else {
        clack.log.info(
          "Assignee roles available: none (operator, reader, auditor all unset)",
        );
      }
    } else {
      // UX (M-T2): Merge the no-creds warn + next-steps + roles-available
      // lines into ONE warn block. Three stacked clack blocks with `│`
      // connectors between them read poorly; one multi-line warn is scan-
      // friendly.
      const rolesLine =
        availableRoles.length > 0
          ? `Assignee roles available: ${availableRoles.join(", ")}`
          : "Assignee roles available: none (operator, reader, auditor all unset)";
      clack.log.warn(
        "No AWS credentials detected. The project config will still be created.\n" +
          "Next steps: run `assignee setup` to create least-privilege IAM users (recommended), " +
          "OR export `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` before running `assignee plan`.\n" +
          "Note: `AWS_PROFILE` alone is not currently supported — use explicit env vars or run " +
          "`assignee setup` to create role-specific credentials.\n" +
          rolesLine,
      );
    }

    // ── Region detection ──────────────────────────────────────────────
    const regionResult = await detectRegion();

    // ── Check for existing config ─────────────────────────────────────
    const configDir = path.resolve(process.cwd(), CONFIG_DIR);
    const configPath = path.join(configDir, CONFIG_FILE);

    try {
      await fs.access(configPath);
      // Item 4b (2026-04-10): surface the resolved project-config
      // path so users see what's about to be overwritten. The project
      // config lives under ./.assignee/config.yaml by default — easy
      // to miss if you're in a subdirectory and didn't expect init
      // to walk up.
      const overwrite = await clack.confirm({
        message: `Project config already exists at ${configPath}. Overwrite it?`,
        initialValue: false,
      });

      if (clack.isCancel(overwrite) || overwrite === false) {
        clack.outro(
          `Keeping existing configuration at ${configPath}. No changes made.`,
        );
        return;
      }
    } catch {
      // Config does not exist — proceed
    }

    // ── Interactive prompts ───────────────────────────────────────────
    const region = await clack.text({
      message: "AWS Region",
      initialValue: regionResult.region ?? DEFAULT_AWS_REGION,
    });

    if (clack.isCancel(region)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return;
    }

    const profile = await clack.text({
      message: "AWS Profile",
      initialValue: credentialResult.profile ?? "default",
    });

    if (clack.isCancel(profile)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return;
    }

    const environment = await clack.select({
      message: "Environment",
      options: [...ENVIRONMENT_OPTIONS],
    });

    if (clack.isCancel(environment)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return;
    }

    // P1-4 (Wave-2 F6, 2026-04-14): Project init previously collapsed the
    // three-way `ask|apply|skip` choice used by `init --global` into a
    // boolean yes/no, silently mapping `yes → apply` and `no → ask`. That
    // violated the `feedback_autofix_user_decides` memory: the user MUST
    // be able to pick `skip`. Match the global init's 3-way select exactly
    // so the behaviour is consistent across project and global scopes.
    const autoFix = await clack.select({
      message:
        "Auto-fix security best-practice violations? (encryption, IMDSv2, public access blocking, etc.)",
      options: [
        {
          value: AutoFixMode.ASK,
          label: "ask — prompt before each fix (default)",
        },
        { value: AutoFixMode.APPLY, label: "apply — fix automatically" },
        { value: AutoFixMode.SKIP, label: "skip — never auto-fix" },
      ],
      initialValue: AutoFixMode.ASK,
    });

    if (clack.isCancel(autoFix)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return;
    }

    // ── Write config file ─────────────────────────────────────────────
    const autoFixMode =
      autoFix as (typeof AutoFixMode)[keyof typeof AutoFixMode];
    const config: ProjectConfig = {
      region: region as string,
      profile: profile as string,
      tags: {
        [AssigneeTag.KEY]: AssigneeTag.VALUE,
        environment: environment as string,
      },
      // Retain the legacy boolean shape for back-compat with older code
      // paths that still read `autoFixBestPractices`: `apply` → true,
      // `ask`/`skip` → false. The authoritative value lives in
      // `preferences.auto_fix` below.
      autoFixBestPractices: autoFixMode === AutoFixMode.APPLY,
      // Nested AssigneeConfig shape consumed by project-config-loader
      defaults: {
        region: region as string,
        tags: {
          [AssigneeTag.KEY]: AssigneeTag.VALUE,
          environment: environment as string,
        },
      },
      preferences: {
        // Persist the 3-mode user decision straight to the project config
        // (not just env). `user-config-loader` reads this key when
        // resolving auto-fix behavior.
        auto_fix: autoFixMode,
      },
    };

    await fs.mkdir(configDir, { recursive: true });

    const yamlContent =
      "# Generated by assignee init\n" + yamlStringify(config);
    await fs.writeFile(configPath, yamlContent, "utf-8");

    // ── Success output ────────────────────────────────────────────────
    const profileNote =
      config.profile !== "default" ? ` with profile ${config.profile}` : "";
    clack.outro(
      `Initialized assignee.ai for region ${config.region}${profileNote}. Run \`assignee plan\` to get started.`,
    );
  });
