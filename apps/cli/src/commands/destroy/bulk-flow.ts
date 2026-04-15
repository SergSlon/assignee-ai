/**
 * Bulk destroy flow — `assignee destroy --all`.
 *
 * Plans tier-ordered destruction of managed resources, requires strict
 * confirmation ("destroy all"), and executes sequentially with progress.
 *
 * @see Story 36.3
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import { AssigneeError, UserCancelledError } from "@assignee/core";
import {
  startSpinner,
  stopSpinner,
  updateSpinner,
} from "../../utils/display.js";
import { operatorCredentials } from "../../config/operator-credentials.js";
import { UserMessage } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import { destroySingleResource } from "../../services/destroy-service.js";
import { planBulkDestroy } from "../../services/bulk-destroy.js";
import {
  renderBulkPlanTable,
  renderBulkSummary,
  renderBulkResults,
} from "./result-formatter.js";

/** Handles the --all bulk destroy flow. */
export async function bulkDestroyAction(opts: {
  yes?: boolean;
  includeIam?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const awsConfig = operatorCredentials();
  const region = awsConfig.region;

  // ── Plan ────────────────────────────────────────────────────────────
  startSpinner("Planning bulk destruction...");

  const plan = await planBulkDestroy({
    includeIam: opts.includeIam,
    region,
  });

  stopSpinner();

  if (plan.resources.length === 0) {
    process.stdout.write("No managed resources found to destroy.\n");
    return;
  }

  renderBulkPlanTable(plan);
  renderBulkSummary(plan);

  // ── Dry run ─────────────────────────────────────────────────────────
  if (opts.dryRun) {
    process.stdout.write(
      process.stdout.isTTY
        ? chalk.dim("Dry run — no resources were destroyed.\n")
        : "Dry run — no resources were destroyed.\n",
    );
    return;
  }

  // ── Primary confirmation ────────────────────────────────────────────
  if (opts.yes) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming bulk destroy.\n",
      );
    }
  } else {
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Bulk destroy irreversibly removes every Assignee-managed resource and needs an explicit confirmation prompt, but stdin is not a TTY. For CI / non-interactive runs, pass `--yes` to acknowledge the blast radius and skip the prompt.",
        ErrorCode.DESTROY_ERROR,
      );
    }

    const answer = await clack.text({
      message: `Type ${chalk.red('"destroy all"')} to confirm destruction of ${plan.resources.length} resources`,
      validate(value) {
        if (value !== "destroy all") {
          return 'You must type exactly "destroy all" to confirm.';
        }
      },
    });

    if (clack.isCancel(answer)) {
      clack.outro(UserMessage.BULK_DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.BULK_DESTROY_CANCELLED);
    }
  }

  // ── IAM additional confirmation ─────────────────────────────────────
  if (opts.includeIam) {
    if (opts.yes) {
      process.stderr.write(
        chalk.yellow(
          "⚠ --yes with --include-iam: IAM policies/roles WILL be destroyed\n",
        ),
      );
    } else {
      if (!process.stdin.isTTY) {
        throw new AssigneeError(
          "Destroying IAM policies and roles can lock Assignee itself out of your account, so `--include-iam` requires a second explicit confirmation, but stdin is not a TTY. For CI / non-interactive runs, pass `--yes` alongside `--include-iam` to acknowledge the extra risk and skip the second prompt.",
          ErrorCode.DESTROY_ERROR,
        );
      }

      const iamAnswer = await clack.text({
        message: `IAM resources included. Type ${chalk.red('"include iam"')} to confirm`,
        validate(value) {
          if (value !== "include iam") {
            return 'You must type exactly "include iam" to confirm.';
          }
        },
      });

      if (clack.isCancel(iamAnswer)) {
        clack.outro(UserMessage.BULK_DESTROY_CANCELLED);
        throw new UserCancelledError(UserMessage.BULK_DESTROY_CANCELLED);
      }
    }
  }

  // ── Execute destruction in tier order ───────────────────────────────
  const total = plan.resources.length;
  let destroyed = 0;
  let failed = 0;

  startSpinner(
    `Destroying 1/${total}: ${plan.resources[0]!.resourceType} ${plan.resources[0]!.arn}`,
  );

  for (let i = 0; i < total; i++) {
    const resource = plan.resources[i]!;
    const progress = `Destroying ${i + 1}/${total}: ${resource.resourceType} ${resource.arn}`;

    updateSpinner(progress);

    try {
      const result = await destroySingleResource(resource, {
        silent: true,
        region: resource.region,
        onProgress: (msg) => updateSpinner(`${i + 1}/${total}: ${msg}`),
      });

      if (result.success) {
        destroyed++;
      } else {
        failed++;
        process.stderr.write(
          `${chalk.red("x")} Failed: ${resource.arn} — ${result.error}\n`,
        );
      }
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${chalk.red("x")} Error: ${resource.arn} — ${message}\n`,
      );
    }
  }

  stopSpinner(`Bulk destroy complete.`);

  renderBulkResults({ destroyed, failed });
}
