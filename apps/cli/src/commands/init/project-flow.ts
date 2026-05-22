/**
 * Project init flow — ./.assignee/config.yaml.
 *
 * Reports credential status (non-fatal), detects region, and writes the
 * project config via the project-wizard.
 *
 * Epic 92 u.d: accepts a `NonInteractiveOverrides` bag so the Commander
 * entry point can drive the flow non-interactively when `--yes` /
 * `--region` / `--auto-fix` are supplied. Interactive path (no flags)
 * is unchanged — the prompts still fire when the override fields are
 * undefined.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { stringify as yamlStringify } from "yaml";
import { loadUserConfig, type AssigneeConfig } from "@assignee/core";
import {
  detectCredentials,
  detectRegion,
} from "../../services/credential-detector.js";
import { CHECKPOINT_DIR, FileName } from "../../config/constants.js";
import { detectAvailableRoles } from "./credentials-detect.js";
import { promptProjectConfig } from "./project-wizard.js";
import type { NonInteractiveOverrides } from "./project-config-types.js";

export type { NonInteractiveOverrides } from "./project-config-types.js";

/**
 * Report the credential state with a single concise clack block.
 */
function reportCredentialState(credentialResult: {
  detected: boolean;
  source?: string;
  profile?: string;
}): void {
  const availableRoles = detectAvailableRoles();
  if (credentialResult.detected) {
    clack.log.success(
      `AWS credentials detected (source: ${credentialResult.source})`,
    );
    if (availableRoles.length > 0) {
      clack.log.info(`Assignee roles available: ${availableRoles.join(", ")}`);
    } else {
      clack.log.info(
        "Assignee roles available: none (operator, reader, auditor all unset)",
      );
    }
  } else {
    // UX (M-T2): single multi-line warn block, scan-friendly.
    const rolesLine =
      availableRoles.length > 0
        ? `Assignee roles available: ${availableRoles.join(", ")}`
        : "Assignee roles available: none (operator, reader, auditor all unset)";
    clack.log.warn(
      "No AWS credentials detected. The project config will still be created.\n" +
        "Next steps: run `assignee dev setup` to create least-privilege IAM users (recommended), " +
        "OR export `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` before running `assignee infra plan`.\n" +
        "Note on `AWS_PROFILE`: setting the env var alone isn't enough — it needs a " +
        "matching profile in `~/.aws/credentials` with `aws_access_key_id` + " +
        "`aws_secret_access_key`. The next prompt records a profile name in your " +
        "project config for documentation; it doesn't authenticate API calls.\n" +
        rolesLine,
    );
  }
}

/**
 * F4 fix (2026-05-23): surface inherited global-config values
 * (defaults.tags + defaults.naming.prefix) to the user during project
 * init so they aren't surprised by tags/prefix appearing on their
 * resources without ever having entered them locally.
 *
 * The resolver at `packages/core/src/config/resolve-global-config.ts:
 * 105-118` already shallow-merges global + project tags per-key, so
 * the inheritance ALREADY works at runtime. The audit's "silently
 * overridden" claim was wrong on the merge side — but the
 * discoverability gap was real. This helper closes it.
 *
 * Emits one `clack.log.info` block per non-empty global default:
 *
 *   • `tags`         → "Inherited from global config: tag <k>=<v>, …"
 *   • `naming.prefix`→ "Inherited from global config: prefix=<P>"
 *
 * Silent when no global config exists (loader returns undefined).
 */
async function reportInheritedGlobalDefaults(): Promise<void> {
  try {
    const userConfig = await loadUserConfig();
    if (!userConfig) return;
    // UserConfig is `UserResourceConfig & {...}` — the per-resource-type
    // map uses an index signature, but the AssigneeConfig top-level
    // keys (`defaults`, `preferences`, `budget`, `org_policy`) ARE
    // present at runtime (the file is parsed against the same YAML
    // schema). Cast to AssigneeConfig so TypeScript lets us access
    // `defaults.tags` / `defaults.naming.prefix` directly without
    // bracket gymnastics.
    const ac = userConfig as unknown as AssigneeConfig;
    const lines: string[] = [];
    const tags = ac.defaults?.tags;
    if (tags && Object.keys(tags).length > 0) {
      const pairs = Object.entries(tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`tags: ${pairs}`);
    }
    const prefix = ac.defaults?.naming?.prefix;
    if (prefix) {
      lines.push(`naming prefix: ${prefix}`);
    }
    if (lines.length > 0) {
      clack.log.info(
        `Inherited from global config (~/.config/assignee/config.yaml). ` +
          `Will apply at apply-time via the config resolver:\n  ${lines.join("\n  ")}`,
      );
    }
  } catch {
    // Loader is best-effort: malformed user config should NEVER block
    // project init. Silent fallback matches existing loadUserConfig
    // contract ("never throws").
  }
}

/** Run the project-level init flow. */
export async function runProjectInit(
  overrides: NonInteractiveOverrides = {},
): Promise<void> {
  const credentialResult = await detectCredentials();
  reportCredentialState(credentialResult);

  // F4 (2026-05-23): surface inherited global config so users
  // understand why tags/prefix may appear on resources without ever
  // being entered in the project wizard.
  await reportInheritedGlobalDefaults();

  const regionResult = await detectRegion();

  const configDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
  const configPath = path.join(configDir, FileName.CONFIG);

  // Check for existing config
  try {
    await fs.access(configPath);
    // D-06: when --yes is set, treat it as implicit overwrite consent.
    // This matches how `npm init --yes` / `gh init --yes` behave and lets
    // CI pipelines re-run init without an interactive block.
    if (overrides.yes === true) {
      // Silent overwrite; caller opted in via --yes.
    } else {
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
    }
  } catch {
    // Config does not exist — proceed
  }

  const config = await promptProjectConfig(
    {
      region: overrides.region ?? regionResult.region,
      profile: credentialResult.profile,
    },
    overrides,
  );
  if (!config) return;

  await fs.mkdir(configDir, { recursive: true });

  const yamlContent =
    "# Generated by assignee dev init\n" + yamlStringify(config);
  await fs.writeFile(configPath, yamlContent, "utf-8");

  const profileNote =
    config.profile !== "default" ? ` with profile ${config.profile}` : "";
  clack.outro(
    `Initialized assignee.ai for region ${config.region}${profileNote}. Run \`assignee infra plan\` to get started.`,
  );
}
