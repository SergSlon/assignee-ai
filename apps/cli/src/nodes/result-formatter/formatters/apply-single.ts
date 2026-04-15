/**
 * Single-resource apply SUCCESS formatter.
 *
 * Display/log/billing use the resolved full ARN; graph state.resourceArn stays
 * as the bare CCAPI identifier UNLESS resolution transformed it (SSM Parameter
 * case — see the lengthy rationale in the original result-formatter.ts). The
 * partial-state return respects the legacy `expect(result).toEqual({})`
 * assertions in result-formatter.test.ts.
 */

import chalk from "chalk";
import type { StructuredTool } from "@langchain/core/tools";
import { RESOURCE_TYPES } from "@assignee/core";
import type { AgentState } from "../../../services/graph.js";
import { renderApplySuccess } from "../../../utils/display.js";
import { log, LOG_ACTIONS } from "../../../utils/logger.js";
import { checkSecurityPosture } from "../../../utils/security-posture.js";
import {
  writeProvisionRecord,
  clearFailureHistory,
} from "../../../utils/memory-recorder.js";
import { resolveDisplayArn } from "../arn-display.js";
import { runStaticSiteUploadFor } from "./static-site-upload.js";

export async function formatApplySingleSuccess(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  const displayArn = await resolveDisplayArn(
    state.resourceType,
    state.resourceArn,
  );

  renderApplySuccess(state, displayArn);
  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.APPLY_SUCCEEDED,
    extras: { resourceArn: displayArn },
  });

  // Story 37.4 — static-site upload when --source is set and the resource is S3.
  if (
    state.sourceDir &&
    state.resourceType === RESOURCE_TYPES.S3_BUCKET &&
    state.resourceArn
  ) {
    await runStaticSiteUploadFor(state.resourceArn, state.sourceDir);
  }

  if (state.sourceDir && state.resourceType !== RESOURCE_TYPES.S3_BUCKET) {
    process.stderr.write(
      chalk.yellow(
        `\u26A0 --source flag ignored: file upload only supported for S3 buckets, not ${state.resourceType}\n`,
      ),
    );
  }

  // Story 19.3 — provision record uses the full ARN so billing lookups work.
  await writeProvisionRecord(
    state.runId,
    state.resourceType,
    displayArn,
    state.desiredState,
    state.estimatedMonthlyCost,
  );

  // Story 20.13 — wipe stale failure history for this resource type.
  await clearFailureHistory(state.runId, state.resourceType);

  // Story 19.2 — security posture check (non-blocking).
  if (displayArn && tools) {
    await checkSecurityPosture(displayArn, tools, state.runId);
  }

  // 2026-04-11 fix: propagate the full ARN into final state ONLY when the
  // resolver actually transformed the identifier (e.g. SSM parameter name
  // "/app/env/key" → "arn:aws:ssm:...:parameter/app/env/key"). See the
  // detailed commentary in result-formatter.ts for why we can't return
  // {resourceArn: displayArn} unconditionally — the compound marker
  // resolver feeds state.resourceArn verbatim into child VpcId/SubnetId
  // fields that reject full ARNs.
  if (displayArn && displayArn !== state.resourceArn) {
    return { resourceArn: displayArn };
  }
  return {};
}
