/**
 * Sequential guard runner. Executes guards in the order supplied; the
 * first FAIL short-circuits the sweep.
 *
 * Matches the original monolithic preflight-guard.ts ordering:
 *   1. required-fields
 *   2. placeholder-arn
 *   3. sentinel-password
 *   4. managed-policy
 */
import type { GuardContext, GuardResult, PreflightGuard } from "./types.js";

export interface RunnerOutcome {
  /**
   * undefined = all guards passed / skipped.
   * string    = first guard that FAILED — this is the error message to
   *             surface to the user.
   */
  readonly errorMessage?: string;
  readonly failedGuardId?: string;
}

export async function runGuards(
  guards: readonly PreflightGuard[],
  ctx: GuardContext,
): Promise<RunnerOutcome> {
  for (const guard of guards) {
    const result: GuardResult = await guard.run(ctx);
    if (result.kind === "fail") {
      return { errorMessage: result.errorMessage, failedGuardId: guard.id };
    }
  }
  return {};
}
