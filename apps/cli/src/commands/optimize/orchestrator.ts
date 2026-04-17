/**
 * Optimize orchestrator — wires target resolution → recommendation
 * gathering → filter/sort → human-readable OR JSON output.
 *
 * Wave-6d F4: split from optimize.ts.
 */
import { fetchManagedResources } from "../../services/list-resources.js";
import { AWS_REGION } from "../../config/constants.js";
import type { CommandContext } from "../../utils/command-runner.js";
import { parseOptimizeArgs } from "./arg-parser.js";
import { gatherRecommendations, rankRecommendations } from "./recommender.js";
import { renderSummary, renderTable } from "./formatter.js";
import type { OptimizeOpts } from "./types.js";

export interface RunOptimizeArgs {
  resourceId: string | undefined;
  opts: OptimizeOpts;
}

export async function runOptimize(
  ctx: CommandContext,
  args: RunOptimizeArgs,
): Promise<{ success: boolean }> {
  const { resourceId, opts } = args;
  const noColor = opts.color === false;
  const asJson = opts.json === true;

  const region = opts.region ?? AWS_REGION;
  const allResources = await fetchManagedResources(region);

  // Optional single-resource filter. Matches on the full ARN or on the
  // trailing name segment for operator convenience.
  const targets = resourceId
    ? allResources.filter(
        (r) =>
          r.arn === resourceId ||
          r.arn.endsWith(`/${resourceId}`) ||
          r.arn.endsWith(`:${resourceId}`),
      )
    : allResources;

  const { minSavingsUsd, error } = parseOptimizeArgs(opts);
  if (error) {
    process.stderr.write(error + "\n");
    return { success: false };
  }

  const { recommendations: allRecommendations, analyzed } =
    await gatherRecommendations(targets, ctx.tools);

  const recommendations = rankRecommendations(
    allRecommendations,
    minSavingsUsd,
  );

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          scanned: targets.length,
          analyzed,
          skippedMissingCheckpoint: targets.length - analyzed,
          recommendations,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    if (recommendations.length > 0) {
      renderTable(recommendations, noColor);
    }
    renderSummary(targets.length, recommendations, analyzed);
  }

  return { success: true };
}
