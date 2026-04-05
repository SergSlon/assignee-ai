/**
 * result_formatter node — final rendering gate.
 * Handles all terminal outcomes: SUCCESS, FAILED, CANCELLED, and plan-mode preview.
 *
 * This is a thin orchestrator that delegates to:
 *   - utils/security-posture.ts  — post-provision security checks
 *   - utils/memory-recorder.ts   — provision/failure memory recording
 *
 * @see Story 2-4, Story 9-6, Story 18-3
 */

import {
  ExecutionStatus,
  ExecutionMode,
  type ResourceResult,
} from "@assignee/core";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import type { StructuredTool } from "@langchain/core/tools";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderError,
  renderPlanBox,
  promptFixSelection,
} from "../utils/display.js";
import { defaultErrorMessageRegistry } from "../utils/error-messages.js";
import {
  defaultErrorHintRegistry,
  PatternId,
  RESOURCE_TYPES,
} from "@assignee/core";
import { AWS_REGION } from "../config/constants.js";
import { EnvVar } from "../constants/env-vars.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";
import { checkSecurityPosture } from "../utils/security-posture.js";
import {
  writeProvisionRecord,
  writeFailureRecord,
  clearFailureHistory,
  upsertPatternRecord,
} from "../utils/memory-recorder.js";

/** Format byte count into a human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Post-provision: upload static site files to S3, create CloudFront distribution,
 * and show the website URLs (Story 37.4).
 * Non-blocking: upload/CloudFront failures are logged as warnings but never mark
 * the provision as failed.
 */
async function uploadStaticSiteFiles(
  bucketName: string,
  sourceDir: string,
  createCloudFront = false,
): Promise<void> {
  const { uploadStaticSite } = await import("../services/s3-upload.js");

  const region =
    process.env[EnvVar.AWS_REGION] ??
    process.env[EnvVar.AWS_DEFAULT_REGION] ??
    AWS_REGION;

  // 1. Upload files to S3
  const spinner = clack.spinner();
  spinner.start("Uploading files...");

  const result = await uploadStaticSite(bucketName, sourceDir, {
    onProgress: (p: { current: number; total: number; file: string }) => {
      spinner.message(`Uploading ${p.current}/${p.total}: ${p.file}`);
    },
  });

  spinner.stop(
    `Uploaded ${result.uploaded} files (${formatBytes(result.totalBytes)})`,
  );

  if (result.failed > 0) {
    process.stderr.write(
      chalk.yellow(`\u26A0 ${result.failed} files failed to upload\n`),
    );
    for (const err of result.errors) {
      process.stderr.write(chalk.dim(`  ${err.file}: ${err.error}\n`));
    }
  }

  if (!createCloudFront) {
    // No CloudFront — set public-read bucket policy and show S3 website URL only
    try {
      const { configureBucketPolicy } =
        await import("../services/s3-upload.js");
      await configureBucketPolicy(bucketName);
    } catch {
      process.stderr.write(
        chalk.dim("  Could not set public-read bucket policy.\n"),
      );
    }

    const s3Url = `http://${bucketName}.s3-website-${region}.amazonaws.com`;
    process.stdout.write(chalk.cyan(`\n\uD83C\uDF10 Website URL: ${s3Url}\n`));
    return;
  }

  // 2. Create CloudFront distribution with OAC
  try {
    const { createCloudFrontDistribution, generateCloudFrontBucketPolicy } =
      await import("../services/cloudfront-setup.js");
    const { PutBucketPolicyCommand, S3Client } =
      await import("@aws-sdk/client-s3");
    const { operatorCredentials: getOperatorCreds } =
      await import("../config/operator-credentials.js");

    const cfSpinner = clack.spinner();
    cfSpinner.start("Creating CloudFront distribution...");

    const cfResult = await createCloudFrontDistribution(bucketName, region);

    // 3. Update bucket policy to use OAC (replaces public-read)
    const creds = getOperatorCreds();
    creds.region = region;
    const s3Client = new S3Client({
      region: creds.region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
      },
    });
    const oacPolicy = generateCloudFrontBucketPolicy(
      bucketName,
      cfResult.distributionArn,
    );
    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: bucketName,
        Policy: oacPolicy,
      }),
    );

    cfSpinner.stop("CloudFront distribution created");

    // Show both URLs
    const s3Url = `http://${bucketName}.s3-website-${region}.amazonaws.com`;
    const cfUrl = `https://${cfResult.domainName}`;
    process.stdout.write(
      chalk.cyan(`\n\uD83C\uDF10 S3 Website URL: ${s3Url}\n`),
    );
    process.stdout.write(
      chalk.cyan(`\u2601 CloudFront distribution created: ${cfUrl}\n`),
    );
    process.stdout.write(
      chalk.dim(`  Distribution ID: ${cfResult.distributionId}\n`),
    );
    process.stdout.write(
      chalk.dim(
        "  Status: InProgress (may take 5-15 minutes to fully deploy)\n",
      ),
    );
    process.stdout.write(chalk.green(`  Recommended URL: ${cfUrl}\n`));
  } catch (cfErr) {
    // CloudFront failure is non-blocking — fall back to S3 website URL
    process.stderr.write(
      chalk.yellow(
        `\u26A0 CloudFront setup failed: ${cfErr instanceof Error ? cfErr.message : String(cfErr)}\n`,
      ),
    );
    process.stderr.write(
      chalk.dim("  Falling back to S3 website hosting (HTTP only).\n"),
    );

    // Set public-read bucket policy as fallback
    try {
      const { configureBucketPolicy } =
        await import("../services/s3-upload.js");
      await configureBucketPolicy(bucketName);
    } catch {
      process.stderr.write(
        chalk.dim("  Could not set public-read bucket policy either.\n"),
      );
    }

    const s3Url = `http://${bucketName}.s3-website-${region}.amazonaws.com`;
    process.stdout.write(chalk.cyan(`\n\uD83C\uDF10 Website URL: ${s3Url}\n`));
  }
}

export async function resultFormatterNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.RESULT_FORMATTED,
    extras: { executionStatus: state.executionStatus },
  });

  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS: {
      // Compound mode: accumulate result and signal loop to continue
      if (
        state.resourcePattern &&
        state.resourceQueue &&
        state.currentResourceIndex !== undefined
      ) {
        const currentResource = state.resourceQueue[state.currentResourceIndex];
        if (!currentResource)
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage: `Compound resource index ${state.currentResourceIndex} out of bounds (queue length ${state.resourceQueue.length})`,
          };
        const completedEntry: ResourceResult = {
          resourceId: currentResource.resourceId,
          resourceType: currentResource.resourceType,
          resourceArn: state.resourceArn,
          executionStatus: ExecutionStatus.SUCCESS,
        };
        const updatedCompleted = [
          ...(state.completedResources ?? []),
          completedEntry,
        ];
        const nextIndex = state.currentResourceIndex + 1;

        if (nextIndex < state.resourceQueue.length) {
          // More resources to provision — update state for next iteration
          const nextResource = state.resourceQueue[nextIndex];
          if (!nextResource) {
            return {
              executionStatus: ExecutionStatus.FAILED,
              errorMessage: `Internal error: resource queue corrupted at index ${nextIndex}. ${updatedCompleted.length} of ${state.resourceQueue!.length} resources completed.`,
              completedResources: updatedCompleted,
            };
          }
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "info",
            action: LOG_ACTIONS.APPLY_SUCCEEDED,
            extras: {
              resourceArn: state.resourceArn,
              resourceType: currentResource.resourceType,
              compound: true,
            },
          });
          return {
            completedResources: updatedCompleted,
            currentResourceIndex: nextIndex,
            resourceType: nextResource.resourceType,
            desiredState: undefined,
            requestToken: undefined,
            resourceArn: undefined,
            executionStatus: ExecutionStatus.PENDING, // Reset for next resource
          };
        }

        // All resources provisioned — render compound summary
        renderCompoundSuccess(updatedCompleted, state.resourcePattern);
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: { compound: true, completedCount: updatedCompleted.length },
        });

        // Story 19.3: write provision record for each completed resource
        for (const completed of updatedCompleted) {
          await writeProvisionRecord(
            state.runId,
            completed.resourceType,
            completed.resourceArn,
            undefined,
            state.perResourceCosts?.[completed.resourceId ?? ""],
          );
        }

        // Story 20.13: clear stale failure history for all successfully provisioned resource types
        const succeededTypes = new Set(
          updatedCompleted
            .filter((r) => r.executionStatus === ExecutionStatus.SUCCESS)
            .map((r) => r.resourceType),
        );
        for (const resourceType of succeededTypes) {
          await clearFailureHistory(state.runId, resourceType);
        }

        // Story 19.5: Write pattern memory record for compound patterns
        if (state.resourcePattern) {
          await upsertPatternRecord(
            state.runId,
            state.resourcePattern.patternId,
            state.elicitedOptions ?? {},
          );
        }

        // Story 19.2: Post-provision security posture check for each compound resource (non-blocking)
        if (tools) {
          for (const resource of updatedCompleted) {
            if (resource.resourceArn) {
              await checkSecurityPosture(
                resource.resourceArn,
                tools,
                state.runId,
              );
            }
          }
        }

        // Story 37.4: Post-provision upload of static site files (compound path)
        if (state.sourceDir) {
          const s3Resource = updatedCompleted.find(
            (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET && r.resourceArn,
          );
          if (s3Resource?.resourceArn) {
            const parts = s3Resource.resourceArn.split(":::");
            const bucketName = parts[1];
            if (!bucketName) {
              process.stderr.write(
                chalk.yellow(
                  `\u26A0 Could not parse bucket name from ARN: ${s3Resource.resourceArn}\n`,
                ),
              );
              // Skip upload for this resource
            } else {
              try {
                const createCf =
                  state.resourcePattern?.patternId === PatternId.STATIC_WEBSITE;
                await uploadStaticSiteFiles(
                  bucketName,
                  state.sourceDir,
                  createCf,
                );
              } catch (err) {
                process.stderr.write(
                  chalk.yellow(
                    `\u26A0 File upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
                  ),
                );
                process.stderr.write(
                  chalk.dim(
                    "  Files can be uploaded manually: aws s3 sync <dir> s3://<bucket>\n",
                  ),
                );
              }
            }
          }
        }

        const hasS3InCompleted = updatedCompleted.some(
          (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET,
        );
        if (state.sourceDir && !hasS3InCompleted) {
          process.stderr.write(
            chalk.yellow(
              `\u26A0 --source flag ignored: file upload only supported for S3 buckets, not ${state.resourceType}\n`,
            ),
          );
        }

        return { completedResources: updatedCompleted };
      }

      // Single-resource path — unchanged
      renderApplySuccess(state);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: { resourceArn: state.resourceArn },
      });

      // Story 37.4: Post-provision upload of static site files
      if (
        state.sourceDir &&
        state.resourceType === RESOURCE_TYPES.S3_BUCKET &&
        state.resourceArn
      ) {
        const parts = state.resourceArn.split(":::");
        const bucketName = parts[1];
        if (!bucketName) {
          process.stderr.write(
            chalk.yellow(
              `\u26A0 Could not parse bucket name from ARN: ${state.resourceArn}\n`,
            ),
          );
          // Skip upload for this resource
        } else {
          try {
            await uploadStaticSiteFiles(bucketName, state.sourceDir);
          } catch (err) {
            // Upload failure must NOT mark the provision as failed
            process.stderr.write(
              chalk.yellow(
                `\u26A0 File upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
              ),
            );
            process.stderr.write(
              chalk.dim(
                "  Files can be uploaded manually: aws s3 sync <dir> s3://<bucket>\n",
              ),
            );
          }
        }
      }

      if (state.sourceDir && state.resourceType !== RESOURCE_TYPES.S3_BUCKET) {
        process.stderr.write(
          chalk.yellow(
            `\u26A0 --source flag ignored: file upload only supported for S3 buckets, not ${state.resourceType}\n`,
          ),
        );
      }

      // Story 19.3: write provision record for single-resource success
      await writeProvisionRecord(
        state.runId,
        state.resourceType,
        state.resourceArn,
        state.desiredState,
        state.estimatedMonthlyCost,
      );

      // Story 20.13: clear stale failure history after successful provision
      await clearFailureHistory(state.runId, state.resourceType);

      // Story 19.2: Post-provision security posture check (non-blocking)
      if (state.resourceArn && tools) {
        await checkSecurityPosture(state.resourceArn, tools, state.runId);
      }

      break;
    }

    case ExecutionStatus.CANCELLED:
      // Silent exit — user intentionally declined
      break;

    case ExecutionStatus.FAILED:
    case ExecutionStatus.POLICY_BLOCKED:
    case ExecutionStatus.UNSUPPORTED_RESOURCE: {
      // Resolve structured error message via the error message registry (Story 18.3)
      const resolved = state.error
        ? defaultErrorMessageRegistry.resolve(state.error)
        : defaultErrorMessageRegistry.resolveMessage(
            state.errorMessage ?? "An unknown error occurred",
          );

      // Legacy hint from ErrorHintRegistry as fallback for howToFix
      const legacyHint = defaultErrorHintRegistry.getHint(state.error);

      // Compound mode: show partial results with cleanup guidance (EC-22)
      if (
        state.resourcePattern &&
        state.completedResources &&
        state.completedResources.length > 0
      ) {
        const successfulResources = state.completedResources.filter(
          (r) => r.executionStatus === ExecutionStatus.SUCCESS,
        );
        const provisioned = successfulResources
          .map((r) => r.resourceType)
          .join(", ");
        const haltedAt = state.resourceType ?? "unknown resource";

        // Build cleanup guidance with ARNs in reverse dependency order
        const resourcesWithArns = successfulResources.filter(
          (r) => r.resourceArn,
        );
        const reversedResources = [...resourcesWithArns].reverse();

        let cleanupGuidance = "";
        if (reversedResources.length > 0) {
          const arnList = reversedResources
            .map(
              (r) => `  - ${r.resourceType}: assignee destroy ${r.resourceArn}`,
            )
            .join("\n");
          cleanupGuidance =
            `\n\nSuccessfully created resources:\n${arnList}` +
            `\n\nTo clean up partially created resources, run the destroy commands above in the listed order (reverse dependency order).`;
        }

        renderError(
          `Provision halted at ${haltedAt}. Previously provisioned: ${provisioned}. Manual cleanup may be required.${cleanupGuidance}`,
          legacyHint ?? resolved.howToFix,
          { why: resolved.why },
        );
      } else {
        renderError(resolved.what, legacyHint ?? resolved.howToFix, {
          why: resolved.why,
        });
      }
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "error",
        action: LOG_ACTIONS.APPLY_FAILED,
        extras: { errorMessage: state.errorMessage },
      });

      // Story 19.4: Write failure record to memory log (fire-and-forget)
      await writeFailureRecord(
        state.runId,
        state.resourceType,
        state.error,
        state.errorMessage,
      );

      break;
    }

    default:
      // PENDING — render plan preview box (plan mode OR apply blocked by BP findings)
      if (
        state.executionMode === ExecutionMode.PLAN ||
        (state.executionMode === ExecutionMode.APPLY && !state.preflightPassed)
      ) {
        if (state.outputFormat === "json") {
          const region =
            process.env[EnvVar.AWS_REGION] ??
            process.env[EnvVar.AWS_DEFAULT_REGION] ??
            AWS_REGION;
          const jsonPayload = {
            resourceType: state.resourceType,
            region,
            desiredState: state.desiredState ?? null,
            estimatedMonthlyCost: state.estimatedMonthlyCost ?? null,
            pricingBreakdown: state.pricingBreakdown ?? null,
            bpFindings: state.bpFindings ?? [],
            appliedFixes: state.appliedFixes ?? [],
            freeTierNote: state.freeTierNote ?? null,
            adviceHints: state.adviceHints ?? [],
            // Compound pattern info (Epic 37)
            ...(state.resourcePattern
              ? {
                  resourcePattern: {
                    patternId: state.resourcePattern.patternId,
                    displayName: state.resourcePattern.displayName,
                    resourceCount: state.resourceQueue?.length ?? 1,
                  },
                  resourceQueue:
                    state.resourceQueue?.map((r) => ({
                      resourceId: r.resourceId,
                      resourceType: r.resourceType,
                      displayName: r.displayName,
                      provisionable: r.provisionable !== false,
                    })) ?? null,
                }
              : {}),
          };
          process.stdout.write(JSON.stringify(jsonPayload, null, 2) + "\n");
        } else {
          renderPlanBox(state);

          // Story 35.4: Interactive fix selection after plan display (TTY only)
          const fixResult = await promptFixSelection(state);
          if (fixResult) {
            // Re-render plan box with updated state — preserve cost estimate
            // (fixes like encryption/versioning don't materially change the rate)
            const updatedState = {
              ...state,
              desiredState: fixResult.desiredState,
              bpFindings: fixResult.bpFindings,
              appliedFixes: fixResult.appliedFixes,
            };
            renderPlanBox(updatedState);
            return {
              desiredState: fixResult.desiredState,
              bpFindings: fixResult.bpFindings,
              appliedFixes: fixResult.appliedFixes,
            };
          }
        }
      }
      break;
  }

  return {};
}
