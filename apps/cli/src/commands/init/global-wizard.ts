/**
 * Global config wizard — prompts user for AssigneeConfig values.
 *
 * @see Story 27.5 — AC #2, #6, #7
 *
 * Epic 96 Wave 2 R2 (D-02 regression of Epic 94 u.d D-39): accepts the
 * same `NonInteractiveOverrides` bag the project wizard consumes. When
 * `overrides.yes` is set, prompts without a matching flag fall back to
 * safe defaults (DEFAULT_AWS_REGION, no tags, no naming prefix,
 * auto_fix=ask). When `overrides.region` or `overrides.autoFix` is
 * supplied, the corresponding prompt is skipped in both interactive
 * and non-interactive runs. Closes the `init --global --yes` hang
 * where clack.text on the region prompt blocked forever under a
 * non-TTY stdin despite the user having explicitly opted in.
 */

import * as clack from "@clack/prompts";
import {
  DEFAULT_AWS_REGION,
  validateConfig,
  AutoFixMode,
} from "@assignee/core";
import type { AssigneeConfig, AutoFixModeType } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import type { NonInteractiveOverrides } from "./project-config-types.js";

/**
 * Prompts the user for global config values and returns an AssigneeConfig object.
 *
 * When `overrides.yes === true` the wizard short-circuits every prompt
 * that lacks a flag equivalent (tags / naming prefix): no interactive
 * tag loop, no prefix prompt, no auto-fix prompt. Individual flags
 * (`--region <r>`, `--auto-fix <mode>`) skip their respective prompts
 * without forcing the whole flow non-interactive.
 */
export async function promptGlobalConfig(
  overrides: NonInteractiveOverrides = {},
): Promise<AssigneeConfig | undefined> {
  const skipPrompts = overrides.yes === true;

  // ── Region ───────────────────────────────────────────────────────────
  let regionValue: string | undefined;
  if (overrides.region !== undefined) {
    regionValue = overrides.region;
  } else if (skipPrompts) {
    // --yes without --region: default to DEFAULT_AWS_REGION so the
    // generated config has a usable value. Users who want a different
    // region should pass --region explicitly.
    regionValue = DEFAULT_AWS_REGION;
  } else {
    const region = await clack.text({
      message: "Default AWS region",
      placeholder: DEFAULT_AWS_REGION,
    });

    if (clack.isCancel(region)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }
    regionValue = (region as string) || undefined;
  }

  // ── Tags (interactive loop only) ────────────────────────────────────
  const tags: Record<string, string> = {};
  if (!skipPrompts) {
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
  }

  // ── Naming prefix (interactive only) ────────────────────────────────
  let prefixValue = "";
  if (!skipPrompts) {
    const prefix = await clack.text({
      message: "Resource naming prefix (optional, press Enter to skip)",
      placeholder: "mycompany-",
    });

    if (clack.isCancel(prefix)) {
      clack.outro(UserMessage.INIT_CANCELLED);
      return undefined;
    }
    prefixValue = prefix as string;
  }

  // ── Auto-fix ─────────────────────────────────────────────────────────
  let autoFixMode: AutoFixModeType;
  if (overrides.autoFix !== undefined) {
    autoFixMode = overrides.autoFix;
  } else if (skipPrompts) {
    autoFixMode = AutoFixMode.ASK;
  } else {
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
    autoFixMode = autoFix as AutoFixModeType;
  }

  const config: AssigneeConfig = {
    defaults: {
      region: regionValue || undefined,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      naming: prefixValue ? { prefix: prefixValue } : undefined,
    },
    preferences: {
      auto_fix: autoFixMode as AssigneeConfig["preferences"] extends {
        auto_fix?: infer T;
      }
        ? T
        : never,
    },
  };

  validateConfig(config);

  return config;
}
