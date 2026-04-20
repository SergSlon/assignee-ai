/**
 * Compound partial-failure renderer.
 *
 * Called when a compound apply halts mid-pattern. Replaces the old
 * inline renderError-with-cleanup-blob that lived in result-formatter.ts
 * and dumped a single multi-line error string with every piece of
 * recovery guidance squashed together.
 *
 * The renderer surfaces four discrete blocks so the user can see at a
 * glance what landed, what broke, what never ran, and what to do next:
 *   (i)   Successfully provisioned
 *   (ii)  Failed
 *   (iii) Not attempted
 *   (iv)  Recovery actions
 *
 * All four blocks are emitted to stderr (not stdout) because this is
 * an error path and the user may be piping stdout to `jq` for JSON
 * output mode.
 *
 * Item 1 (2026-04-09).
 */
import chalk from "chalk";
import boxen from "boxen";
import type {
  ResourceResult,
  ArchitecturePattern,
  ResourceSpec,
} from "../../pattern-templates/types.js";
import { BoxenAlign } from "../../config/constants/ui.js";
import { stopSpinner } from "./spinner.js";

const COMPOSITE_ID_TYPES: ReadonlySet<string> = new Set([
  "AWS::EC2::Route",
  "AWS::EC2::VPCGatewayAttachment",
  "AWS::EC2::SubnetRouteTableAssociation",
]);

interface CompoundPartialFailureInput {
  pattern: ArchitecturePattern;
  completed: ResourceResult[];
  failedResource: {
    resourceId: string;
    resourceType: string;
    displayName?: string;
    errorMessage: string;
  };
  notAttempted: ResourceSpec[];
  runId: string;
}

function buildColorHelpers(isTTY: boolean) {
  return {
    bold: (s: string) => (isTTY ? chalk.bold(s) : s),
    red: (s: string) => (isTTY ? chalk.red(s) : s),
    green: (s: string) => (isTTY ? chalk.green(s) : s),
    yellow: (s: string) => (isTTY ? chalk.yellow(s) : s),
    dim: (s: string) => (isTTY ? chalk.dim(s) : s),
  };
}

function appendSuccessful(
  lines: string[],
  successful: ResourceResult[],
  c: ReturnType<typeof buildColorHelpers>,
): void {
  if (successful.length === 0) return;
  lines.push(c.bold(`Successfully provisioned (${successful.length}):`));
  for (const r of successful) {
    const arnTail = r.resourceArn ? ` → ${r.resourceArn}` : "";
    lines.push(c.green(`  ✓ ${r.resourceType}${arnTail}`));
  }
  lines.push("");
}

function appendFailed(
  lines: string[],
  failed: CompoundPartialFailureInput["failedResource"],
  c: ReturnType<typeof buildColorHelpers>,
): void {
  lines.push(c.bold("Failed:"));
  lines.push(c.red(`  ✖ ${failed.resourceType}`));
  lines.push(
    c.dim(
      `    reason: ${failed.errorMessage || "(no error message captured)"}`,
    ),
  );
  lines.push("");
}

function appendNotAttempted(
  lines: string[],
  notAttempted: ResourceSpec[],
  failedType: string,
  c: ReturnType<typeof buildColorHelpers>,
): void {
  if (notAttempted.length === 0) return;
  lines.push(
    c.bold(
      `Not attempted (${notAttempted.length}) — waiting on ${failedType}:`,
    ),
  );
  for (const r of notAttempted) {
    lines.push(
      c.yellow(
        `  ◦ ${r.resourceType}${r.displayName ? ` (${r.displayName})` : ""}`,
      ),
    );
  }
  lines.push("");
}

function appendRecovery(
  lines: string[],
  successful: ResourceResult[],
  runId: string,
  c: ReturnType<typeof buildColorHelpers>,
): void {
  lines.push(c.bold("Next steps:"));
  if (successful.length === 0) {
    lines.push(
      c.dim(
        "  Nothing was provisioned. Fix the error reported above and re-run your `assignee apply` command.",
      ),
    );
    return;
  }
  const resourcesWithArns = successful.filter((r) => r.resourceArn);
  const reversed = [...resourcesWithArns].reverse();
  lines.push(
    c.dim(
      "  To unwind the partial state, run the destroy commands below in order",
    ),
  );
  lines.push(
    c.dim(
      "  (reverse dependency order — lines starting with `#` cascade from a parent):",
    ),
  );
  for (const r of reversed) {
    if (COMPOSITE_ID_TYPES.has(r.resourceType)) {
      lines.push(
        c.dim(
          `    # ${r.resourceType}: cascades from parent (composite id ${r.resourceArn})`,
        ),
      );
    } else {
      lines.push(`    assignee destroy ${r.resourceArn}`);
    }
  }
  lines.push("");
  lines.push(
    c.dim(`  Or retry from the failed step after addressing the root cause:`),
  );
  lines.push(
    `    assignee apply --checkpoint .assignee/checkpoint-${runId}.json`,
  );
}

export function renderCompoundPartialFailure(
  input: CompoundPartialFailureInput,
): void {
  stopSpinner();

  const successful = input.completed.filter(
    (r) => r.resourceType !== undefined,
  );
  const isTTY = process.stderr.isTTY;
  const c = buildColorHelpers(isTTY);

  const lines: string[] = [];

  lines.push(
    c.red(
      `✖ ${input.pattern.displayName} halted at ${input.failedResource.resourceType}${input.failedResource.displayName ? ` (${input.failedResource.displayName})` : ""}.`,
    ),
  );
  lines.push("");

  appendSuccessful(lines, successful, c);
  appendFailed(lines, input.failedResource, c);
  appendNotAttempted(
    lines,
    input.notAttempted,
    input.failedResource.resourceType,
    c,
  );
  appendRecovery(lines, successful, input.runId, c);
  lines.push("");

  const body = lines.join("\n");

  if (isTTY) {
    process.stderr.write(
      boxen(body, {
        title: "Compound Provisioning Halted",
        titleAlignment: BoxenAlign.LEFT,
        borderColor: "red",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stderr.write(
      `=== Compound Provisioning Halted ===\n${body}\n====================================\n`,
    );
  }
}
