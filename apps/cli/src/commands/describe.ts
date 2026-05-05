/**
 * `assignee describe` command — re-render the apply-success line for a
 * previously-applied resource by run id or ARN.
 *
 * Single positional invocation form: `assignee describe <run-id-or-arn>`.
 * The polymorphism (UUID-shaped runId vs. partition-aware ARN) is
 * resolved by `MemoryService.readProvisionRecord` — see the regex in
 * `packages/core/src/services/memory/service.ts:readProvisionRecord`.
 *
 * Output contract: byte-identical to the original apply-success line
 * (Stories ii + iii own the formatter, this command consumes it). For
 * EC2 instances, the LIVE PublicIpAddress / PublicDnsName are fetched
 * via DescribeInstances and substituted into the render. When the live
 * IP differs from the apply-time IP (stop/start cycles re-issue public
 * IPs), an inline annotation `(was <old-ip> at apply time)` is printed
 * directly beneath the Public IP line in the same style — without
 * mutating `apply-success.ts`.
 *
 * @see _bmad-output/implementation-artifacts/ssh-bundle-iv-describe-command.md
 */

import { Command } from "commander";
import chalk from "chalk";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  AssigneeError,
  serializeErrorEnvelope,
  renderApplySuccess,
} from "@assignee/core";
import { renderError } from "../utils/display.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { resolveJsonMode, redactAccountIdIfDemoMode } from "./output-format.js";
import {
  describeResource,
  DescribeNotFoundError,
} from "../services/describe-resource.js";
import { ProcessExitCode } from "../constants/errors.js";

/**
 * Print the inline `(was <old-ip> at apply time)` annotation directly
 * under the Public IP line. Style matches the green TTY / plain-text
 * non-TTY format used by `renderApplySuccess`'s renderNetwork helper
 * so the two outputs sit visually on the same surface.
 */
function renderPublicIpDivergenceAnnotation(
  publicIpAddressAtApply: string,
): void {
  const isTty = !!process.stdout.isTTY;
  const line = `(was ${publicIpAddressAtApply} at apply time)`;
  if (isTty) {
    // Three-space indent + dim styling so the annotation is visibly
    // subordinate to the Public IP line above. Matches the dim
    // `Run ID:` line that the apply-success renderer prints below.
    process.stdout.write(chalk.dim(`               ${line}\n`));
  } else {
    process.stdout.write(`${line}\n`);
  }
}

/**
 * Construct a fresh `Command` instance for `assignee describe`.
 *
 * Tests MUST use this factory rather than the singleton `describeCommand`
 * exported below — Commander mutates a shared `_optionValues` object
 * across `parseAsync` invocations on the same Command, which leaks
 * `--json` (and any other option) from one test into the next inside
 * the same describe block. A factory gives every test a clean
 * Command with no leaked option state.
 */
export function buildDescribeCommand(): Command {
  return new Command(CommandName.DESCRIBE)
    .description(CommandDescription.DESCRIBE)
    .argument(
      "<run-id-or-arn>",
      "Run id (UUID) or full resource ARN to describe. Use `assignee list --json` to discover both.",
    )
    .option("-o, --output <format>", "Output format (json|text)", "text")
    .option("--json", "Shorthand for --output json")
    .addHelpText(
      "after",
      `
Examples:
  $ assignee describe 550e8400-e29b-41d4-a716-446655440000
        Re-render the apply-success line by run id (live Public IP if EC2).
  $ assignee describe arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def4567890
        Re-render by ARN (full ARN, partition-aware).
  $ assignee describe <run-id> --json | jq .
        Machine-readable envelope for scripts.

describe is read-only — it never mutates provision records. No --yes
flag required. EC2 instances issue a live DescribeInstances; non-EC2
resources render from the local provision record only.
`,
    )
    .action(describeAction);
}

async function describeAction(
  runIdOrArn: string,
  opts: { json?: boolean; output?: string },
): Promise<void> {
  const jsonMode = resolveJsonMode(opts);
  opts.json = jsonMode || opts.json;
  const stderrFilter = installJsonStderrFilter(jsonMode);

  try {
    try {
      const result = await describeResource(runIdOrArn);

      if (jsonMode) {
        // Symmetric with `assignee list --json` — discriminated
        // envelope on `.ok` so scripts can distinguish a successful
        // describe from a not-found / fetch-failed error response.
        // The provision record is included verbatim (all fields,
        // including `publicIpAddressAtApply` when present) so a
        // caller can reconstruct the apply-time snapshot without a
        // second SDK call.
        const envelope = {
          ok: true as const,
          runId: result.provision.runId,
          arn: result.provision.resourceArn,
          resourceType: result.provision.resourceType,
          region: result.provision.region,
          applyTime: result.provision.timestamp,
          ...(result.state.publicIpAddress
            ? { publicIpAddress: result.state.publicIpAddress }
            : {}),
          ...(result.state.publicDnsName
            ? { publicDnsName: result.state.publicDnsName }
            : {}),
          ...(result.provision.publicIpAddressAtApply
            ? {
                publicIpAddressAtApply: result.provision.publicIpAddressAtApply,
              }
            : {}),
          ...(result.state.keyName ? { keyName: result.state.keyName } : {}),
          ...(result.state.amiId ? { amiId: result.state.amiId } : {}),
          ...(result.state.sshUsername
            ? { sshUsername: result.state.sshUsername }
            : {}),
          liveFetchAttempted: result.liveFetchAttempted,
          liveFetchSucceeded: result.liveFetchSucceeded,
        };
        process.stdout.write(
          redactAccountIdIfDemoMode(JSON.stringify(envelope, null, 2) + "\n"),
        );
        return;
      }

      // Text mode: re-render the apply-success line via the SAME
      // formatter the apply-time path uses (Story ii + iii). The
      // overlay (publicIpAddress, publicDnsName, keyName, amiId,
      // sshUsername) is composed by describeResource into a
      // RenderableState the formatter recognises — output is
      // byte-identical to apply-time except for the divergence
      // annotation printed below.
      renderApplySuccess(result.state, result.displayArn);

      if (result.publicIpAddressAtApplyForAnnotation) {
        renderPublicIpDivergenceAnnotation(
          result.publicIpAddressAtApplyForAnnotation,
        );
      }
    } catch (err: unknown) {
      if (err instanceof DescribeNotFoundError) {
        renderError(
          err.message,
          "Run `assignee list` to see all managed resources, or `assignee list --json | jq` to find a specific run id or ARN.",
          {
            why: "No matching record exists in ~/.assignee/memory/provisions.json.",
          },
        );
        if (jsonMode) {
          process.stdout.write(
            redactAccountIdIfDemoMode(
              serializeErrorEnvelope(
                err.code,
                err.message,
                "Run `assignee list` to see all managed resources.",
              ),
            ),
          );
        }
        process.exitCode = ProcessExitCode.GENERIC_ERROR;
        throw new AssigneeError(err.message, err.code, {
          alreadyRendered: true,
        });
      }

      const message = err instanceof Error ? err.message : String(err);
      renderError(
        "Failed to describe resource.",
        "Check your AWS credentials and try again.",
        { why: message },
      );
      if (jsonMode) {
        process.stdout.write(
          redactAccountIdIfDemoMode(
            serializeErrorEnvelope(
              "DESCRIBE_ERROR",
              "Failed to describe resource.",
              "Check your AWS credentials and try again.",
            ),
          ),
        );
      }
      process.exitCode = ProcessExitCode.GENERIC_ERROR;
      throw new AssigneeError(message, "DESCRIBE_ERROR", {
        alreadyRendered: true,
      });
    }
  } finally {
    stderrFilter.restore();
  }
}

/**
 * Default singleton — wired into the CLI top-level command tree in
 * `apps/cli/src/index.ts`. Production code uses this; tests should
 * call `buildDescribeCommand()` to get a clean instance per test.
 */
export const describeCommand = buildDescribeCommand();
