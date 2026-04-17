/**
 * Guard: reject RDS plans that still carry the template's placeholder
 * MasterUserPassword sentinel. Scoped to `AWS::RDS::DBInstance` and
 * `AWS::RDS::DBCluster` — walking arbitrary nested objects would risk
 * false positives on unrelated services that happen to expose a
 * Password-named field.
 *
 * Mirrors detectPlaceholderArn shape for consistency.
 */
import { PLACEHOLDER_DB_PASSWORDS, RDS_PASSWORD_FIELDS } from "@assignee/core";
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult, skipResult } from "../types.js";

const RDS_PASSWORD_GUARDED_TYPES: ReadonlySet<string> = new Set([
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
]);

export function detectSentinelPassword(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string | undefined {
  if (!RDS_PASSWORD_GUARDED_TYPES.has(resourceType)) return undefined;
  for (const field of RDS_PASSWORD_FIELDS) {
    const value = desiredState[field];
    if (typeof value === "string" && PLACEHOLDER_DB_PASSWORDS.has(value)) {
      return (
        `Field "${field}" is still the placeholder password baked into the ` +
        `pattern template. Override it before apply with: ` +
        `--set ${field}=<a-real-password>. ` +
        `Requirements: 8+ characters; cannot contain '/', '@', '"', or spaces. ` +
        `For automation, generate one with: openssl rand -base64 24 | tr -d '/+=@\"'.`
      );
    }
  }
  return undefined;
}

export const sentinelPasswordGuard: PreflightGuard = {
  id: "sentinel-password",
  async run(ctx: GuardContext): Promise<GuardResult> {
    const rt = ctx.state.resourceType ?? "";
    if (!RDS_PASSWORD_GUARDED_TYPES.has(rt))
      return skipResult("not an RDS type");
    const err = detectSentinelPassword(rt, ctx.desiredState);
    return err ? failResult(err) : passResult;
  },
};
