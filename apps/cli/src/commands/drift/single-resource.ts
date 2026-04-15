/**
 * Single-resource drift detail flow.
 *
 * Wave-6d F4: split from drift.ts (Story 28.3). When the command is
 * invoked with a resource id, look it up in the provision log, resolve
 * the desired state, run a single drift check, and render the detail
 * view (JSON or pretty).
 */
import {
  DriftStatus,
  type DriftResult,
  type ProvisionRecord,
} from "@assignee/core";
import { renderDriftDetail } from "../../views/drift-detail.js";
import { resolveDesiredState } from "../../utils/resolve-desired-state.js";
import type { DriftDetectorService } from "../../services/drift-detector/service.js";
import type { DriftOpts } from "./types.js";

export type Provision = ProvisionRecord;

export interface SingleResourceArgs {
  resourceId: string;
  provisions: Provision[];
  detector: DriftDetectorService;
  opts: DriftOpts;
}

/**
 * Returns true if the flow handled the request (caller should return).
 */
export async function runSingleResourceDetail(
  args: SingleResourceArgs,
): Promise<boolean> {
  const { resourceId, provisions, detector, opts } = args;
  const provision = provisions.find(
    (p) => p.resourceArn === resourceId || p.resourceArn.endsWith(resourceId),
  );
  if (!provision) {
    process.stdout.write(
      `Resource '${resourceId}' not found in provision logs.\n`,
    );
    return true;
  }

  const desiredState = await resolveDesiredState(provision.resourceArn);
  const driftResult: DriftResult = await detector.checkResource(
    provision.resourceType,
    provision.resourceArn,
    desiredState,
  );

  if (opts.json) {
    process.stdout.write(JSON.stringify(driftResult, null, 2) + "\n");
    return true;
  }

  const output = renderDriftDetail(driftResult, {
    noColor: opts.color === false,
    verbose: opts.verbose ?? false,
    lastProvisioned: provision.timestamp,
  });
  process.stdout.write(output + "\n");

  if (driftResult.status === DriftStatus.DRIFTED) {
    process.exitCode = 1;
  }
  return true;
}
