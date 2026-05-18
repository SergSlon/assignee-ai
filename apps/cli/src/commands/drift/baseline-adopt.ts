/**
 * --baseline mode: adopt a single resource into drift tracking.
 *
 * Wave-6d F4: split from drift.ts. Special-case path that runs BEFORE
 * provision-log loading. Calls CCAPI GetResource for the given ARN,
 * parses the Properties JSON string, and writes a baseline file under
 * ~/.assignee/baselines/ keyed by the slugified ARN. The
 * resolveDesiredState() fallback will pick it up on future drift runs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AssigneeError, arnToCloudFormationType } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import { BASELINES_DIR } from "../../config/constants.js";
import { createDriftDetectorFromEnv } from "../../services/drift-detector-factory.js";
import { baselineFilename } from "../../utils/resolve-desired-state.js";

export async function runBaselineAdopt(
  resourceId: string | undefined,
): Promise<void> {
  if (!resourceId) {
    throw new AssigneeError(
      "--baseline requires a resource ARN. Usage: assignee infra drift --baseline <arn>",
      ErrorCode.USAGE_ERROR,
    );
  }

  // Infer the CloudFormation resource type from the ARN's service
  // namespace + trailing resource path.
  const parts = resourceId.split(":");
  const service = parts[2] ?? "";
  const resourcePart = parts.slice(5).join(":");
  const resourceType = arnToCloudFormationType(service, resourcePart);
  if (!resourceType) {
    throw new AssigneeError(
      `Could not infer resource type from ARN '${resourceId}'. Baselines are only supported for recognized AWS services.`,
      ErrorCode.USAGE_ERROR,
    );
  }

  const detectorResult = createDriftDetectorFromEnv();
  if (!detectorResult) {
    throw new AssigneeError(
      "Baseline adoption requires AWS credentials. Configure credentials and try again.",
      ErrorCode.MISSING_CREDENTIALS,
    );
  }
  const { detector } = detectorResult;

  const snapshot = await detector.checkResource(resourceType, resourceId, {});
  const liveState = snapshot.actualState ?? snapshot.desiredState ?? undefined;
  if (!liveState || Object.keys(liveState).length === 0) {
    throw new AssigneeError(
      `CCAPI GetResource returned no state for '${resourceId}'. Verify the ARN exists and operator credentials have permission to read it.`,
      ErrorCode.UNKNOWN,
    );
  }

  const baselineDir = path.resolve(process.cwd(), BASELINES_DIR);
  await fs.mkdir(baselineDir, { recursive: true });
  const baselinePath = path.join(baselineDir, baselineFilename(resourceId));
  const payload = {
    version: 1,
    arn: resourceId,
    resourceType,
    desiredState: liveState,
    adoptedAt: new Date().toISOString(),
    source: "assignee infra drift --baseline",
  };
  await fs.writeFile(
    baselinePath,
    JSON.stringify(payload, null, 2) + "\n",
    "utf-8",
  );
  process.stdout.write(
    `Adopted ${resourceType} into drift tracking.\n` +
      `  arn:       ${resourceId}\n` +
      `  baseline:  ${baselinePath}\n` +
      `  fields:    ${Object.keys(liveState).length}\n\n` +
      `Future \`assignee infra drift\` runs will compare live state against this baseline.\n`,
  );
}
