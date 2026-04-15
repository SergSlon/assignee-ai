/**
 * Global config wizard — prompts user for AssigneeConfig values.
 *
 * @see Story 27.5 — AC #2, #6, #7
 */

import * as clack from "@clack/prompts";
import {
  DEFAULT_AWS_REGION,
  validateConfig,
  AutoFixMode,
} from "@assignee/core";
import type { AssigneeConfig } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";

/**
 * Prompts the user for global config values and returns an AssigneeConfig object.
 */
export async function promptGlobalConfig(): Promise<
  AssigneeConfig | undefined
> {
  const region = await clack.text({
    message: "Default AWS region",
    placeholder: DEFAULT_AWS_REGION,
  });

  if (clack.isCancel(region)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

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
    if (eqIndex <= 0) {
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

  const prefix = await clack.text({
    message: "Resource naming prefix (optional, press Enter to skip)",
    placeholder: "mycompany-",
  });

  if (clack.isCancel(prefix)) {
    clack.outro(UserMessage.INIT_CANCELLED);
    return undefined;
  }

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

  validateConfig(config);

  return config;
}
