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
} from "@assignee/core";
import type { AssigneeConfig } from "@assignee/core";
import {
  detectCredentials,
  detectRegion,
} from "../services/credential-detector.js";
import { resolveConfigPath } from "../config/user-config-loader.js";
import { UserMessage, CHECKPOINT_DIR, FileName } from "../config/constants.js";
import { EnvVar } from "../constants/env-vars.js";

/** Assignee IAM role names detected from environment variables. */
type AssigneeRole = "operator" | "reader" | "auditor";

/**
 * Detect which Assignee IAM roles have credentials configured via environment.
 * Each role pair must have BOTH access key id AND secret access key set
 * (and non-empty) to be considered available.
 */
export function detectAvailableRoles(
  env: NodeJS.ProcessEnv = process.env,
): AssigneeRole[] {
  const available: AssigneeRole[] = [];
  const pairs: ReadonlyArray<readonly [AssigneeRole, string, string]> = [
    ["operator", EnvVar.OPERATOR_ACCESS_KEY, EnvVar.OPERATOR_SECRET_KEY],
    ["reader", EnvVar.READER_ACCESS_KEY, EnvVar.READER_SECRET_KEY],
    ["auditor", EnvVar.AUDITOR_ACCESS_KEY, EnvVar.AUDITOR_SECRET_KEY],
  ];
  for (const [role, keyVar, secretVar] of pairs) {
    const id = env[keyVar];
    const secret = env[secretVar];
    if (id && secret && id.length > 0 && secret.length > 0) {
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
  preferences?: { auto_fix?: string };
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
    if (eqIndex > 0) {
      const key = entryStr.slice(0, eqIndex).trim();
      const val = entryStr.slice(eqIndex + 1).trim();
      if (key && val) tags[key] = val;
    }
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
        const overwrite = await clack.confirm({
          message: "Global config already exists. Overwrite?",
          initialValue: false,
        });

        if (clack.isCancel(overwrite) || overwrite === false) {
          clack.outro("Keeping existing configuration.");
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
    } else {
      clack.log.warn(
        "No AWS credentials detected. The project config will still be created.",
      );
      clack.log.info(
        "Next steps: run `assignee setup` to create IAM users, " +
          "or export AWS_PROFILE / ASSIGNEE_OPERATOR_ACCESS_KEY_ID before running `assignee plan`.",
      );
    }

    if (availableRoles.length > 0) {
      clack.log.info(`Assignee roles available: ${availableRoles.join(", ")}`);
    } else {
      clack.log.info(
        "Assignee roles available: none (operator, reader, auditor all unset)",
      );
    }

    // ── Region detection ──────────────────────────────────────────────
    const regionResult = await detectRegion();

    // ── Check for existing config ─────────────────────────────────────
    const configDir = path.resolve(process.cwd(), CONFIG_DIR);
    const configPath = path.join(configDir, CONFIG_FILE);

    try {
      await fs.access(configPath);
      // Config exists — prompt for overwrite
      const overwrite = await clack.confirm({
        message: "Config already exists. Overwrite?",
        initialValue: false,
      });

      if (clack.isCancel(overwrite) || overwrite === false) {
        clack.outro("Keeping existing configuration.");
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

    const autoFix = await clack.confirm({
      message:
        "Auto-apply security best practices? (encryption, IMDSv2, public access blocking, etc.)",
      initialValue: true,
    });

    if (clack.isCancel(autoFix)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return;
    }

    // ── Write config file ─────────────────────────────────────────────
    const config: ProjectConfig = {
      region: region as string,
      profile: profile as string,
      tags: {
        [AssigneeTag.KEY]: AssigneeTag.VALUE,
        environment: environment as string,
      },
      autoFixBestPractices: autoFix as boolean,
      // Nested AssigneeConfig shape consumed by project-config-loader
      defaults: {
        region: region as string,
        tags: {
          [AssigneeTag.KEY]: AssigneeTag.VALUE,
          environment: environment as string,
        },
      },
      preferences: {
        auto_fix: (autoFix as boolean) ? "apply" : "ask",
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
