/**
 * destroy command action — dispatches to single or bulk flow + arg validation.
 */

import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import { bulkDestroyAction } from "./bulk-flow.js";
import { singleDestroyAction } from "./single-flow.js";

/**
 * Core action handler for the destroy command.
 * Exported for testability — the Commander wrapper delegates to this.
 */
export async function destroyAction(
  resource: string | undefined,
  opts: {
    yes?: boolean;
    all?: boolean;
    includeIam?: boolean;
    dryRun?: boolean;
  },
): Promise<void> {
  // ── Bulk destroy mode ────────────────────────────────────────────
  if (opts.all) {
    if (resource) {
      throw new AssigneeError(
        `--all destroys everything managed by assignee; a specific resource ("${resource}") is ambiguous. Did you mean "assignee destroy --all" (destroy everything) or "assignee destroy ${resource}" (just that one)?`,
        ErrorCode.USAGE_ERROR,
      );
    }
    return bulkDestroyAction(opts);
  }

  // ── Validate flags that only work with --all ─────────────────────
  if (opts.includeIam) {
    throw new AssigneeError(
      "--include-iam only works in bulk-destroy mode because single-resource destroy already targets one explicit ARN. Usage: `assignee destroy --all --include-iam` to sweep every Assignee-managed resource including IAM policies and roles.",
      ErrorCode.DESTROY_ERROR,
    );
  }
  if (opts.dryRun) {
    throw new AssigneeError(
      "--dry-run only works in bulk-destroy mode; a single-resource destroy has nothing to enumerate. Usage: `assignee destroy --all --dry-run` to preview what would be swept without touching AWS.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  if (!resource) {
    throw new AssigneeError(
      "Destroy needs to know what to destroy. Pass a resource ARN or name as the positional argument, e.g. `assignee destroy my-bucket` or `assignee destroy arn:aws:s3:::my-bucket`. To sweep everything Assignee manages at once, use `assignee destroy --all`.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  return singleDestroyAction(resource, opts);
}
