/**
 * `assignee clean --resources` — discovers and destroys stale e2e/test
 * AWS resources matching a strict prefix pattern.
 *
 * Wave-6d F4: split from clean.ts.
 *
 * Prior version used `/e2e|test/i` which matched any production resource
 * whose name contained "test" (e.g., `my-test-logs`). New pattern requires
 * an explicit `e2e-test/` path prefix, `e2e-`/`assignee-e2e-` name prefix,
 * or the `poc-apply-test-` legacy pattern.
 */
import * as clack from "@clack/prompts";
import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import {
  planBulkDestroy,
  type ManagedResource,
} from "../../services/bulk-destroy.js";
import { destroySingleResource } from "../../services/destroy-service.js";
import { UserMessage } from "../../config/constants.js";
import type { CleanOpts } from "./types.js";

/**
 * Formats a table of managed resources for display.
 */
export function formatResourceTable(resources: ManagedResource[]): string {
  const lines: string[] = [];
  const typeWidth = Math.max(
    ...resources.map((r) => r.resourceType.length),
    "Type".length,
  );
  const idWidth = Math.max(
    ...resources.map((r) => r.identifier.length),
    "Identifier".length,
  );

  lines.push(
    `${"Type".padEnd(typeWidth)}  ${"Identifier".padEnd(idWidth)}  Region`,
  );
  lines.push(
    `${"─".repeat(typeWidth)}  ${"─".repeat(idWidth)}  ${"─".repeat(12)}`,
  );

  for (const r of resources) {
    lines.push(
      `${r.resourceType.padEnd(typeWidth)}  ${r.identifier.padEnd(idWidth)}  ${r.region}`,
    );
  }
  return lines.join("\n");
}

export async function cleanResources(opts: CleanOpts): Promise<void> {
  const dryRun = opts.dryRun === true;
  const autoConfirm = opts.confirm || opts.yes;

  // Discover matching resources — strict prefixes only, anchored.
  const plan = await planBulkDestroy({
    pattern: /(?:^|\/|:)(e2e-test\/|e2e-|assignee-e2e-|poc-apply-test-)/i,
  });

  if (plan.resources.length === 0) {
    clack.log.info("No stale test resources found.");
    return;
  }

  const table = formatResourceTable(plan.resources);
  clack.note(table, `${plan.resources.length} test/e2e resources found`);

  if (dryRun) {
    clack.log.info(
      "Dry run — no resources destroyed. Run with --confirm to execute.",
    );
    return;
  }

  // Confirmation gate.
  if (autoConfirm) {
    // auto-confirm via --yes / --confirm
  } else if (process.stdin.isTTY) {
    const answer = await clack.text({
      message: `Type "clean" to destroy ${plan.resources.length} resources`,
    });
    if (clack.isCancel(answer) || answer !== "clean") {
      clack.log.warn(UserMessage.RESOURCE_CLEANUP_CANCELLED);
      return;
    }
  } else {
    // Non-TTY without --yes is an error.
    throw new AssigneeError(
      "Resource cleanup requires confirmation. Use --yes for non-interactive mode.",
      ErrorCode.USAGE_ERROR,
    );
  }

  // Execute destruction with progress spinner.
  const spinner = clack.spinner();
  const total = plan.resources.length;
  let succeeded = 0;
  let failed = 0;

  spinner.start(
    `Cleaning 1/${total}: ${plan.resources[0]!.resourceType} ${plan.resources[0]!.identifier}`,
  );

  for (let i = 0; i < total; i++) {
    const resource = plan.resources[i]!;
    spinner.message(
      `Cleaning ${i + 1}/${total}: ${resource.resourceType} ${resource.identifier}`,
    );

    const result = await destroySingleResource(resource, {
      region: resource.region,
      silent: true,
    });

    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  spinner.stop(`Cleaned ${succeeded} resources, ${failed} failed`);
}
