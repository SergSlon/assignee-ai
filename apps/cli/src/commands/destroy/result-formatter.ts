/**
 * Rendering helpers for destroy command — boxes + success line.
 *
 * Story 50-3: bulk renderers (renderBulkPlanTable/Summary/Results) were
 * removed along with the `--all` bulk destroy flow.
 */

import chalk from "chalk";
import boxen from "boxen";
import { BoxenAlign } from "../../config/constants.js";

/**
 * Resource types that live in the AWS global control plane — their
 * resources are not region-scoped even though the CLI always has a
 * resolved AWS_REGION on hand for API calls. `list` already reports
 * these as `region: "global"` (see
 * `packages/core/src/list-resources/fetch-managed-resources.ts:170`);
 * the destroy confirmation box must render the same string so users
 * don't see conflicting region labels between `list` and `destroy`.
 *
 * Epic 92 u.e (D-16): IAM Role destroy previously showed
 * `Region: us-east-1` because the resolver fills the AWS credential
 * region regardless of whether the resource is actually region-scoped.
 *
 * Covered prefixes:
 *   - `AWS::IAM::*`         — IAM (users/roles/policies/groups)
 *   - `AWS::CloudFront::*`  — CloudFront distributions + OAC
 * Not covered (region-scoped despite a global-ish feel):
 *   - `AWS::S3::Bucket`     — buckets live in a single region
 *   - `AWS::Route53::*`     — zones are global, but record sets
 *                             resolve by zone id, not region — if a
 *                             future release supports destroy for
 *                             Route53, add the prefix here.
 */
function isGlobalResourceType(resourceType: string): boolean {
  return (
    resourceType.startsWith("AWS::IAM::") ||
    resourceType.startsWith("AWS::CloudFront::")
  );
}

/** Render resource details box before confirmation. */
export function renderDestroyBox(resource: {
  resourceType: string;
  arn: string;
  region: string;
  identifier: string;
  estimatedMonthlyCost: string;
}): void {
  // Epic 92 u.e (D-16): override the region label for global resource
  // types so the destroy box matches how `list` already reports them.
  const displayRegion = isGlobalResourceType(resource.resourceType)
    ? "global"
    : resource.region;
  const content = [
    `Resource Type:   ${resource.resourceType}`,
    `ARN:             ${resource.arn}`,
    `Region:          ${displayRegion}`,
    `Identifier:      ${resource.identifier}`,
    `Estimated Cost:  ${resource.estimatedMonthlyCost}`,
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Destroy Resource",
        titleAlignment: BoxenAlign.CENTER,
        borderColor: "red",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Destroy Resource ===\n${content}\n========================\n`,
    );
  }
}

/** Success message with estimated savings. */
export function renderDestroySuccess(estimatedMonthlyCost: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(
      chalk.green(
        `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
      ),
    );
  } else {
    process.stdout.write(
      `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
    );
  }
}

/**
 * Scheduled-deletion success message for resource types that AWS refuses
 * to hard-delete synchronously. The previous `renderDestroySuccess`
 * ("Resource destroyed.") line is a lie for these types:
 *
 *   - KMS::Key — `ScheduleKeyDeletion` puts the key into `PendingDeletion`
 *     with a 7-30 day window (closes Epic 92 D-21). During the window
 *     the key keeps billing and remains cryptographically reversible.
 *   - SecretsManager::Secret — `DeleteSecret` without `ForceDeleteWithoutRecovery`
 *     imposes a mandatory 7-30 day recovery window (closes D-25).
 *     The secret continues to incur per-secret monthly charges during the
 *     window.
 *
 * Honest phrasing: "Scheduled for deletion on <ISO date>. Estimated
 * savings after deletion: <cost>".
 */
export function renderDestroyScheduled(
  scheduledAt: Date,
  estimatedMonthlyCost: string,
): void {
  // Render `YYYY-MM-DD` (UTC). Full ISO would add a time component that
  // is not actionable for users planning cost cut-off dates; the UTC
  // date-only form matches how AWS reports `DeletionDate` /
  // `ScheduledDeletionDate` in the console.
  const iso = scheduledAt.toISOString().slice(0, 10);
  const line = `Scheduled for deletion on ${iso}. Estimated savings after deletion: ${estimatedMonthlyCost}\n`;
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.green(line));
  } else {
    process.stdout.write(line);
  }
}
