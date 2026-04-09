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
  renderCompoundPartialFailure,
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
import { emitTokenUsageSummary } from "../utils/token-usage.js";
import type { AgentState } from "../services/graph.js";
import { checkSecurityPosture } from "../utils/security-posture.js";
import { resolveResourceArn } from "../utils/resolve-arn.js";
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
 * Post-provision: upload static site files to an already-created S3
 * bucket.
 *
 * Pre (f) 2026-04-09 Task 4b this helper ALSO used direct SDK calls
 * to create a CloudFront distribution, Origin Access Control, and
 * update the S3 BucketPolicy — a ~430 LOC SDK post-provision hook in
 * cloudfront-setup.ts. All three of those operations are now
 * first-class CCAPI resources owned by the static-website compound
 * pattern (AWS::CloudFront::OriginAccessControl +
 * AWS::CloudFront::Distribution + AWS::S3::BucketPolicy), so this
 * helper is now ONLY responsible for uploading the user's application
 * files to S3. Everything else flows through the main CCAPI graph.
 *
 * Non-blocking: upload failures are logged as warnings but never mark
 * the provision as failed.
 */
async function uploadStaticSiteFiles(
  bucketName: string,
  sourceDir: string,
): Promise<void> {
  const { uploadStaticSite } = await import("../services/s3-upload.js");

  // Upload files to S3
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
}

/**
 * Print the CloudFront URL for a completed static-website compound.
 *
 * The distribution's domain is deterministic: CloudFront assigns
 * `<distribution-id>.cloudfront.net` at create time. Once the
 * distribution resource is in `completedResources` we can synthesize
 * the URL without a GetResource call. Propagation still takes 5-15
 * minutes before traffic actually flows through the edge network —
 * we call that out explicitly so users don't think something is
 * broken when the URL 404s immediately after apply.
 *
 * @see (f) 2026-04-09 Task 4b — replaced the cloudfront-setup.ts
 *      SDK post-provision flow; URL display is now the only
 *      post-compound hook for static-website
 */
function printStaticWebsiteCloudFrontUrl(
  completedResources: readonly ResourceResult[],
): void {
  const distribution = completedResources.find(
    (r) =>
      r.resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION &&
      r.resourceArn,
  );
  if (!distribution?.resourceArn) return;
  // The distribution's CCAPI primaryIdentifier is the bare Id
  // (e.g. "E1ABCDEFG12345"). CloudFront assigns the public domain
  // `<id>.cloudfront.net` deterministically at create time.
  const distributionId = distribution.resourceArn;
  const cfUrl = `https://${distributionId}.cloudfront.net`;
  process.stdout.write(
    chalk.cyan(`\n\u2601 CloudFront distribution created: ${cfUrl}\n`),
  );
  process.stdout.write(chalk.dim(`  Distribution ID: ${distributionId}\n`));
  process.stdout.write(
    chalk.dim(
      "  Status: propagating (may take 5-15 minutes before traffic flows)\n",
    ),
  );
  process.stdout.write(chalk.green(`  Recommended URL: ${cfUrl}\n`));
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

  // Wave 12 P0: emit one TOKEN_USAGE_SUMMARY entry per command, regardless
  // of execution outcome (SUCCESS / FAILED / CANCELLED / plan-mode preview).
  // This way every command produces exactly one summary row that downstream
  // analysis can grep with `action=token_usage_summary`. Failures still
  // accumulated tokens before they failed — those costs are real.
  emitTokenUsageSummary(state.runId);

  switch (state.executionStatus) {
    case ExecutionStatus.SUCCESS: {
      // BUG-5 + V6 P0 regression fix: resolve the bare CCAPI primary
      // identifier to a full ARN for DISPLAY/LOG/BILLING ONLY. Do NOT
      // mutate state.resourceArn — the compound marker resolver in
      // plan-generator.ts (`resolveCompoundMarkers` → line 423) reads
      // `match.resourceArn` and substitutes it verbatim into child
      // EC2 fields like VpcId, SubnetId, InternetGatewayId. Those APIs
      // require BARE identifiers (vpc-0xxx, subnet-0xxx, igw-0xxx) and
      // reject full ARNs. Wave 8 originally mutated state.resourceArn
      // and broke every VPC compound apply at step 2/17 — caught by
      // Adversarial Hunter v6.
      //
      // resolveResourceArn is a no-op when state.resourceArn is already
      // an ARN (CCAPI returns full ARNs for ELBv2/ECS Cluster/SNS Topic)
      // or when STS lookup fails (returns bare identifier — best-effort).
      const displayArn = state.resourceType
        ? ((await resolveResourceArn({
            resourceType: state.resourceType,
            identifier: state.resourceArn,
          })) ?? state.resourceArn)
        : state.resourceArn;

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
          // BARE CCAPI identifier — must NOT be the full ARN. The next
          // iteration's compound marker resolver substitutes this value
          // into VpcId/SubnetId/IgwId fields where AWS rejects ARNs.
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
              // Log the resolved ARN for observability; the graph
              // state still carries the bare identifier for the
              // marker resolver on the next iteration.
              resourceArn: displayArn,
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

        // All resources provisioned — build a displayArns map keyed by
        // resourceId so renderCompoundSuccess / provision record /
        // security posture check all show the resolved full ARN, while
        // completedResources[].resourceArn stays as the bare CCAPI
        // identifier expected by any downstream drift/reconcile path.
        const displayArns: Record<string, string> = {};
        for (const completed of updatedCompleted) {
          if (completed.resourceId && completed.resourceArn) {
            const resolved =
              (await resolveResourceArn({
                resourceType: completed.resourceType,
                identifier: completed.resourceArn,
              })) ?? completed.resourceArn;
            displayArns[completed.resourceId] = resolved;
          }
        }

        renderCompoundSuccess(
          updatedCompleted,
          state.resourcePattern,
          displayArns,
        );
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.APPLY_SUCCEEDED,
          extras: { compound: true, completedCount: updatedCompleted.length },
        });

        // Story 19.3: write provision record for each completed resource
        // — use the resolved full ARN so the provision log records a
        // usable value (billing MCP rejects bare CCAPI identifiers).
        for (const completed of updatedCompleted) {
          const arnForRecord =
            (completed.resourceId && displayArns[completed.resourceId]) ||
            completed.resourceArn;
          await writeProvisionRecord(
            state.runId,
            completed.resourceType,
            arnForRecord,
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
        // — use the resolved full ARN; SecurityHub findings are keyed by ARN.
        if (tools) {
          for (const resource of updatedCompleted) {
            const arnForCheck =
              (resource.resourceId && displayArns[resource.resourceId]) ||
              resource.resourceArn;
            if (arnForCheck) {
              await checkSecurityPosture(arnForCheck, tools, state.runId);
            }
          }
        }

        // Story 37.4: Post-provision upload of static site files (compound path)
        if (state.sourceDir) {
          const s3Resource = updatedCompleted.find(
            (r) => r.resourceType === RESOURCE_TYPES.S3_BUCKET && r.resourceArn,
          );
          if (s3Resource?.resourceArn) {
            // CCAPI primary identifier for S3 IS the bucket name. The
            // entry's resourceArn now stores that bare identifier (V6
            // P0 fix), so prefer it directly. Fall back to parsing the
            // arn:aws:s3::: prefix in case a future code path stores a
            // full ARN here instead.
            const bucketName = s3Resource.resourceArn.startsWith("arn:")
              ? (s3Resource.resourceArn.split(":::")[1] ?? "")
              : s3Resource.resourceArn;
            if (!bucketName) {
              process.stderr.write(
                chalk.yellow(
                  `\u26A0 Could not parse bucket name from ARN: ${s3Resource.resourceArn}\n`,
                ),
              );
              // Skip upload for this resource
            } else {
              try {
                await uploadStaticSiteFiles(bucketName, state.sourceDir);
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

        // (f) 2026-04-09 Task 4b: for the static-website compound, print
        // the CloudFront URL synthesized from the distribution Id.
        // This replaces the old post-provision SDK flow in
        // cloudfront-setup.ts — the distribution is now a regular CCAPI
        // resource in the compound so its Id is already in
        // updatedCompleted.
        if (state.resourcePattern?.patternId === PatternId.STATIC_WEBSITE) {
          printStaticWebsiteCloudFrontUrl(updatedCompleted);
        }

        return { completedResources: updatedCompleted };
      }

      // Single-resource path — display/log/billing use the resolved
      // full ARN; graph state.resourceArn stays as the bare CCAPI
      // identifier (terminal node, but keeping it consistent with
      // the compound branch for any future refactor).
      renderApplySuccess(state, displayArn);
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.APPLY_SUCCEEDED,
        extras: { resourceArn: displayArn },
      });

      // Story 37.4: Post-provision upload of static site files
      if (
        state.sourceDir &&
        state.resourceType === RESOURCE_TYPES.S3_BUCKET &&
        state.resourceArn
      ) {
        // state.resourceArn is the bare bucket name post-V6 P0 fix.
        // Defensive parsing in case a future path stores a full ARN.
        const bucketName = state.resourceArn.startsWith("arn:")
          ? (state.resourceArn.split(":::")[1] ?? "")
          : state.resourceArn;
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
      // — use the resolved full ARN so billing lookups succeed.
      await writeProvisionRecord(
        state.runId,
        state.resourceType,
        displayArn,
        state.desiredState,
        state.estimatedMonthlyCost,
      );

      // Story 20.13: clear stale failure history after successful provision
      await clearFailureHistory(state.runId, state.resourceType);

      // Story 19.2: Post-provision security posture check (non-blocking)
      // — use the full ARN; SecurityHub findings are keyed by ARN.
      if (displayArn && tools) {
        await checkSecurityPosture(displayArn, tools, state.runId);
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

      // Compound mode: Item 1 (2026-04-09) — delegate to the dedicated
      // renderCompoundPartialFailure renderer. The previous inline
      // implementation squashed everything into a single renderError
      // blob that hid the "not attempted" resources from the user and
      // buried the recovery commands in narrative text. The new
      // renderer surfaces four discrete blocks (success / failure /
      // not attempted / recovery) so partial failure is always readable
      // at a glance, and the unattempted-resources list is derived
      // from state.resourceQueue[currentResourceIndex + 1..] so users
      // understand the blast radius of the halt.
      if (
        state.resourcePattern &&
        state.resourceQueue &&
        state.completedResources &&
        state.completedResources.length > 0 &&
        state.currentResourceIndex !== undefined
      ) {
        const successfulResources = state.completedResources.filter(
          (r) => r.executionStatus === ExecutionStatus.SUCCESS,
        );
        const failedResourceSpec =
          state.resourceQueue[state.currentResourceIndex];
        const notAttempted = state.resourceQueue.slice(
          state.currentResourceIndex + 1,
        );

        renderCompoundPartialFailure({
          pattern: state.resourcePattern,
          completed: successfulResources,
          failedResource: {
            resourceId: failedResourceSpec?.resourceId ?? "unknown",
            resourceType:
              failedResourceSpec?.resourceType ??
              state.resourceType ??
              "unknown",
            displayName: failedResourceSpec?.displayName,
            errorMessage: resolved.what,
          },
          notAttempted,
          runId: state.runId,
        });
        // Also log the legacy hint / why-block through the default
        // error channel so the user still sees the structured hint
        // guidance alongside the partial-failure box.
        if (resolved.why || legacyHint || resolved.howToFix) {
          renderError(
            `Compound apply halted — see the Compound Provisioning Halted box above for recoverable state.`,
            legacyHint ?? resolved.howToFix,
            { why: resolved.why },
          );
        }
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
          // Tier S #3: pass the compound queue into the renderable state so
          // renderPlanBox displays a "Compound: N resources" listing INSIDE
          // the boxen frame. The original Wave 19 fix wrote a separate
          // prelude block ABOVE the boxen frame, which gave TTY users two
          // disconnected blocks; this version is one unified frame.
          const stateWithQueue =
            state.resourcePattern &&
            state.resourceQueue &&
            state.resourceQueue.length > 0
              ? {
                  ...state,
                  compoundQueue: {
                    patternDisplayName: state.resourcePattern.displayName,
                    resources: state.resourceQueue.map((r) => ({
                      resourceType: r.resourceType,
                      ...(r.displayName ? { displayName: r.displayName } : {}),
                    })),
                  },
                }
              : state;
          renderPlanBox(stateWithQueue);

          // Story 35.4: Interactive fix selection after plan display (TTY only)
          const fixResult = await promptFixSelection(state);
          if (fixResult) {
            // Re-render plan box with updated state — preserve cost estimate
            // (fixes like encryption/versioning don't materially change the rate).
            // Also preserve the compound queue listing (Tier S #3) so the
            // re-rendered frame still shows the full pattern, not just the
            // first resource.
            const updatedState = {
              ...stateWithQueue,
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
