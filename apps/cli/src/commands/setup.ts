/**
 * `assignee setup` command — creates IAM users, policies, and access keys
 * for the 3-user credential separation model.
 *
 * Requires admin/root AWS credentials. Idempotent: safe to re-run.
 *
 * Wave 6b F3 (2026-04-14): refactored from a 902-LOC monolith into
 * cohesive sub-modules under ./setup/. This file now orchestrates
 * them in straight-line order — each phase has single-responsibility
 * and can be unit-tested in isolation.
 *
 * @see Story 18.8 — IAM Security Overhaul
 * @see .agents/stories/wave-6b-f3-setup-solid.md
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { IAMClient } from "@aws-sdk/client-iam";
import { AssigneeError } from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ErrorCode, ProcessExitCode } from "../constants/errors.js";
import { UserMessage } from "../config/constants.js";
import { resolveIntroContext, formatIntroContext } from "./init.js";
import { printSetupIntro } from "./setup/intro.js";
import {
  printSetupDryRun,
  printDisableLoggingDryRun,
} from "./setup/dry-run.js";
import { runDisableLoggingFastPath } from "./setup/disable-logging.js";
import {
  buildAdminClientConfig,
  verifyAdminCredentials,
} from "./setup/credentials.js";
import { collectRotationDecisions } from "./setup/rotation-prompts.js";
import { provisionUsers } from "./setup/provision-users.js";
import { setupBedrockLogging } from "./setup/bedrock-logging.js";
import { printInteractivePlan, writeEnvAndSummary } from "./setup/summary.js";

// Re-export intro context helpers so any caller that used to import them
// from "./setup.js" continues to work without code changes.
export { resolveIntroContext, formatIntroContext };

export const setupCommand = new Command(CommandName.SETUP)
  .description(
    CommandDescription.SETUP +
      " The operator role is REQUIRED — setup aborts if it fails.",
  )
  .option(
    "--profile <profile>",
    "AWS CLI profile with admin/root credentials (reads from ~/.aws/credentials)",
  )
  .option("-y, --yes", "Skip confirmation prompts")
  .option(
    "--enable-llm-logging",
    "PRIVACY: Enable Bedrock invocation text logging to CloudWatch (logs every prompt and response). Default: OFF.",
    false,
  )
  .option(
    "--disable-llm-logging",
    "PRIVACY: Explicitly DISABLE Bedrock invocation text logging (idempotent). Runs only the PutModelInvocationLoggingConfiguration call with textDataDeliveryEnabled=false; does NOT re-run the full IAM wizard. Mutually exclusive with --enable-llm-logging.",
    false,
  )
  .option(
    "--dry-run",
    "Print the plan of resources that WOULD be created without invoking any AWS APIs",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee setup --profile admin
        Interactive wizard (creates Operator/Reader/Auditor IAM users)
  $ assignee setup --profile admin --yes
        Non-interactive setup (skips all confirmations, for CI bootstrap)
  $ assignee setup --profile admin --dry-run
        Print the plan without calling any IAM APIs
  $ assignee setup --profile admin --disable-llm-logging
        Turn off Bedrock invocation text logging (idempotent)
`,
  )
  .action(
    async (options: {
      profile?: string;
      yes?: boolean;
      enableLlmLogging?: boolean;
      disableLlmLogging?: boolean;
      dryRun?: boolean;
    }) => {
      // UX (Sally): --enable and --disable are mutually exclusive.
      // Thrown as AssigneeError(USAGE_ERROR) so errorToExitCode maps to
      // exit 73 (USAGE_ERROR) rather than exit 1 (GENERIC_ERROR).
      // Mirror of W9-S4 fix on init.ts (--wizard + --yes mutex).
      if (options.enableLlmLogging && options.disableLlmLogging) {
        throw new AssigneeError(
          "Flags --enable-llm-logging and --disable-llm-logging are mutually exclusive. " +
            "Pass one or the other, not both.",
          ErrorCode.USAGE_ERROR,
        );
      }

      // L2 (Wave 5): render the resolved AWS admin context up front.
      // Under --dry-run we MUST NOT touch AWS (tests assert zero calls),
      // so the intro synthesizes an env-only context.
      await printSetupIntro({
        profile: options.profile,
        suppressSts: options.dryRun === true,
      });

      // ── Disable-only fast path ──────────────────────────────────────
      if (options.disableLlmLogging) {
        if (options.dryRun) {
          printDisableLoggingDryRun();
          return;
        }
        await runDisableLoggingFastPath({ profile: options.profile });
        return;
      }

      // ── Dry-run path: print plan and exit without any AWS calls ─────
      if (options.dryRun) {
        printSetupDryRun({
          enableLlmLogging: options.enableLlmLogging === true,
        });
        return;
      }

      // ── Build credential provider + verify admin credentials ────────
      const { clientConfig } = await buildAdminClientConfig(options.profile);
      const accountId = await verifyAdminCredentials(clientConfig);

      // ── Display plan and confirm ─────────────────────────────────────
      printInteractivePlan();

      if (!options.yes) {
        const confirmed = await clack.confirm({
          message: "Proceed with IAM setup?",
          initialValue: true,
        });

        if (clack.isCancel(confirmed) || !confirmed) {
          clack.outro(UserMessage.SETUP_CANCELLED);
          return;
        }
      }

      const iam = new IAMClient(clientConfig);

      // ── Pre-collect key-rotation decisions (sequential prompts) ─────
      let rotationDecisions = new Map<string, boolean>();
      if (!options.yes) {
        const result = await collectRotationDecisions(iam);
        if (result.cancelled) {
          return;
        }
        rotationDecisions = result.decisions;
      }

      // ── Create/update users, policies, and access keys (parallel) ───
      const { succeeded, envUpdates } = await provisionUsers(
        iam,
        accountId,
        rotationDecisions,
      );

      // ── Operator role is REQUIRED — abort on failure (M-S11) ────────
      const operatorSucceeded = succeeded.some(
        (s) => s.role.key === "operator",
      );
      if (!operatorSucceeded) {
        clack.log.error(
          "Operator role failed to provision. The operator user is REQUIRED " +
            "for every assignee command. Aborting setup without writing .env. " +
            "Inspect the IAM error above and re-run `assignee setup`.",
        );
        clack.outro("Setup aborted: operator role is required.");
        process.exitCode = ProcessExitCode.GENERIC_ERROR;
        return;
      }

      // ── Bedrock invocation logging (Tasks 1–4 from aws-bootstrap.md) ──
      await setupBedrockLogging({
        iam,
        clientConfig,
        accountId,
        enableLlmLogging: options.enableLlmLogging === true,
      });

      // ── .env write + summary ────────────────────────────────────────
      writeEnvAndSummary(envUpdates);
    },
  );
