/**
 * `assignee update <target> --source <dir>` command.
 *
 * Refreshes a deployed static-website in one shot: uploads new files
 * to S3, optionally deletes remote orphans, and invalidates the
 * fronting CloudFront distribution. Replaces the manual
 * `aws s3 sync && aws cloudfront create-invalidation` two-step the
 * operator otherwise has to run.
 *
 * Wraps `update/action.ts` (where the real orchestration lives). This
 * file owns Commander wiring + flag surface only.
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { updateAction, type UpdateOpts } from "./update/action.js";

export const updateCommand = new Command(CommandName.UPDATE)
  .description(CommandDescription.UPDATE)
  .argument(
    "<target>",
    "Bucket name, S3 ARN, or runId of the static-website to refresh",
  )
  .option(
    "-s, --source <path>",
    "Path to local directory containing the new site files (required)",
  )
  .option(
    "--delete",
    "Delete remote objects that have no local counterpart (default: OFF — additive uploads only)",
  )
  .option(
    "--invalidation-paths <paths>",
    "Comma-separated paths to invalidate on CloudFront (default: '/*')",
  )
  .option("--no-invalidation", "Skip CloudFront cache invalidation entirely")
  .option(
    "--wait",
    "Poll until invalidation Status === 'Completed' (typically 1-5 min)",
  )
  .option("-y, --yes", "Skip confirmation prompt (for CI/CD)")
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option(
    "--json",
    "Shorthand for --output json (emit machine-readable envelope)",
  )
  .addHelpText(
    "after",
    `\nExamples:\n` +
      `  assignee update my-marketing-site --source ./dist\n` +
      `  assignee update my-marketing-site --source ./dist --delete\n` +
      `  assignee update arn:aws:s3:::my-marketing-site --source ./dist --invalidation-paths "/index.html,/css/*"\n` +
      `  assignee update <runId-uuid> --source ./dist --no-invalidation\n` +
      `  assignee update my-marketing-site --source ./dist --wait --yes --json\n`,
  )
  .action(async (target: string, rawOpts: UpdateOpts) => {
    await updateAction(target, rawOpts);
  });
