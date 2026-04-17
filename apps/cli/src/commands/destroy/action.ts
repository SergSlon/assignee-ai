/**
 * destroy command action — validates required resource arg and dispatches
 * to the single-resource flow. Story 50-3 removed --all / --include-iam /
 * --dry-run (bulk destroy); only per-resource destroy remains.
 */

import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import { singleDestroyAction } from "./single-flow.js";

/**
 * Core action handler for the destroy command.
 * Exported for testability — the Commander wrapper delegates to this.
 */
export async function destroyAction(
  resource: string | undefined,
  opts: {
    yes?: boolean;
  },
): Promise<void> {
  if (!resource) {
    throw new AssigneeError(
      "Destroy needs to know what to destroy. Pass a resource ARN or name as the positional argument, e.g. `assignee destroy my-bucket` or `assignee destroy arn:aws:s3:::my-bucket`.",
      ErrorCode.DESTROY_ERROR,
    );
  }

  return singleDestroyAction(resource, opts);
}
