/**
 * Guard: schema "required" fields present in desiredState.
 *
 * Was inlined at the top of the original preflightGuardNode (Wave 6 pre-
 * refactor lines 340-351). Mirrors the same error message verbatim.
 */
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult } from "../types.js";

export const requiredFieldsGuard: PreflightGuard = {
  id: "required-fields",
  async run(ctx: GuardContext): Promise<GuardResult> {
    const required =
      (ctx.state.resourceSchema?.["required"] as string[] | undefined) ?? [];
    const missing = required.filter((f) => !(f in ctx.desiredState));
    if (missing.length === 0) return passResult;
    return failResult(
      `Missing required fields for ${ctx.state.resourceType}: ${missing.join(
        ", ",
      )}. Include them in your intent, e.g. "Create a lambda with role arn:aws:iam::ACCOUNT_ID:role/my-role".`,
    );
  },
};
