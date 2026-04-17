/**
 * Guard: reject LLM-hallucinated placeholder ARNs in desiredState.
 *
 * Walks desiredState recursively (depth-capped at 32 to defend against
 * cycles / hostile deeply-nested JSON — Wave 11 P2-7 / edge finding #7)
 * and returns a friendly error when an ARN's account-ID segment matches
 * one of the known AWS docs example account IDs (123456789012 et al).
 *
 * Partition-aware: relies on `ARN_ACCOUNT_REGEX` which anchors on
 * `^arn:aws[\w-]*:` so `arn:aws-us-gov:...` and `arn:aws-cn:...` ARNs
 * still trip the guard.
 */
import {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "../../../../constants/placeholder-accounts.js";
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult } from "../types.js";

const PLACEHOLDER_WALK_MAX_DEPTH = 32;

export function detectPlaceholderArn(
  desiredState: Record<string, unknown>,
): string | undefined {
  function walk(
    value: unknown,
    path: string,
    depth: number,
  ): { field: string; arn: string; account: string } | undefined {
    if (depth > PLACEHOLDER_WALK_MAX_DEPTH) return undefined;
    if (typeof value === "string") {
      const match = ARN_ACCOUNT_REGEX.exec(value);
      if (match && PLACEHOLDER_AWS_ACCOUNT_IDS.has(match[1]!)) {
        return { field: path, arn: value, account: match[1]! };
      }
      return undefined;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = walk(value[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const found = walk(v, path ? `${path}.${k}` : k, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  const hit = walk(desiredState, "", 0);
  if (!hit) return undefined;
  return (
    `Field "${hit.field}" contains a placeholder ARN ` +
    `(${hit.arn}). The account ID ${hit.account} is an AWS docs example, ` +
    `not a real account. Provide a real ARN with --set ${hit.field}=arn:aws:... ` +
    `or omit the field entirely if the resource type allows it.`
  );
}

export const placeholderArnGuard: PreflightGuard = {
  id: "placeholder-arn",
  async run(ctx: GuardContext): Promise<GuardResult> {
    const err = detectPlaceholderArn(ctx.desiredState);
    return err ? failResult(err) : passResult;
  },
};
