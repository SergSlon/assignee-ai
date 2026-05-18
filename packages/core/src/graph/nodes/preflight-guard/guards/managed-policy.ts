/**
 * Guard: verify every ManagedPolicyArn on an IAM::Role plan actually
 * exists in IAM (Wave 19 Bug #8).
 *
 * Behaviour preserved verbatim from the original preflight-guard.ts:
 *
 * - Fail-CLOSED when an AWS session-auth failure is seen (ExpiredToken,
 *   InvalidClientTokenId, SignatureDoesNotMatch, TokenRefreshRequired,
 *   HTTP 401). Wave 4 F2 P0-R2-1: a hallucinated ARN slipping past
 *   preflight just because STS expired is exactly the regression we must
 *   not re-introduce.
 * - Per-ARN AccessDenied does NOT abort the sweep — the ARN is marked
 *   "unverified" and the rest continue.
 * - Throttling is retried up to 3× with 200/500/1200ms backoff; if the
 *   retries exhaust, the ARN is marked unverified rather than blocking.
 * - Truly unknown errors → unverified + WARN log (default). Set
 *   `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1` to escalate unknown errors to
 *   fail-closed for stricter SaaS / regulated-tenant posture (Story 48.3,
 *   opt-in). Auth / AccessDenied / Throttling branches are unaffected.
 * - If client construction itself surfaces an auth failure, fail closed.
 *   Any other construction failure → WARN + fall through (no block).
 *
 * IAM is global; us-east-1 is the canonical control-plane region.
 */
import {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "@/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { EnvVar } from "@/constants/env-vars.js";
import type { ConfigPort } from "@/config/config-port.js";
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult, skipResult } from "../types.js";

const THROTTLE_BACKOFF_MS = [200, 500, 1200] as const;

export async function verifyManagedPolicyArns(
  arns: readonly string[],
  config: ConfigPort,
): Promise<string | null> {
  if (arns.length === 0) return null;
  try {
    const { IAMClient, GetPolicyCommand } = await import("@aws-sdk/client-iam");
    const { tryAssigneeCredentials } =
      await import("@/config/aws-credentials.js");
    const creds = tryAssigneeCredentials("operator");
    const iam = new IAMClient({
      region: "us-east-1",
      ...(creds
        ? {
            credentials: {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
              // W2-01: pass session token for STS/SSO short-term credentials.
              ...(creds.sessionToken
                ? { sessionToken: creds.sessionToken }
                : {}),
            },
          }
        : {}),
    });

    const invalidArns: { arn: string; reason: string }[] = [];
    const unverifiedArns: { arn: string; reason: string }[] = [];

    for (const arn of arns) {
      let verifyErr: unknown;
      let attempt = 0;
      for (;;) {
        try {
          await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
          verifyErr = undefined;
          break;
        } catch (err) {
          verifyErr = err;
          if (isThrottlingError(err) && attempt < THROTTLE_BACKOFF_MS.length) {
            await new Promise((r) =>
              setTimeout(r, THROTTLE_BACKOFF_MS[attempt]!),
            );
            attempt += 1;
            continue;
          }
          break;
        }
      }
      if (verifyErr === undefined) continue;
      const err = verifyErr;
      const e = err as { name?: string; Code?: string };
      const errName = e?.name ?? "";
      const errCode = e?.Code ?? "";
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errName === "NoSuchEntityException" || errCode === "NoSuchEntity") {
        invalidArns.push({ arn, reason: "policy does not exist in IAM" });
      } else if (isAuthFailureError(err)) {
        return (
          `AWS credentials expired or invalid while verifying ` +
          `ManagedPolicyArns (${errName || errCode || "auth failure"}: ${errMsg}). ` +
          `Preflight cannot validate the plan without working credentials. ` +
          `Run \`assignee dev setup\` or refresh your AWS session (e.g. ` +
          `\`aws sso login\`, renew SAML assertion, or rotate the access key) ` +
          `and re-run the command.`
        );
      } else if (isAccessDeniedError(err)) {
        unverifiedArns.push({
          arn,
          reason: "access denied (iam:GetPolicy) — unverified",
        });
      } else if (isThrottlingError(err)) {
        unverifiedArns.push({
          arn,
          reason: `throttled after ${attempt + 1} attempts — unverified`,
        });
      } else {
        // Story 48.3: opt-in strict mode. Unknown errors default to
        // unverified+WARN (intentional fail-open for local CLI / single-ARN
        // transient network blips). Operators running a stricter posture
        // (SaaS multi-tenant, regulated tenants) set
        // ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1 to escalate to fail-closed.
        // MUST sit inside the else branch (after Auth / NoSuchEntity /
        // AccessDenied / Throttling) so it can never demote those signals.
        // MASTER-009 (RW4b-3): read via the ConfigPort threaded through
        // graph state rather than constructing a fresh adapter per call.
        if (config.get(EnvVar.ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS) === "1") {
          return (
            `Preflight unknown error while verifying ManagedPolicyArn ${arn} ` +
            `(${errName || errCode || "unknown"}): ${errMsg}. ` +
            `Strict mode is enabled via ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1 — ` +
            `unset that env var to fall back to WARN-only behaviour. ` +
            `If credentials or IAM permissions are the root cause, run ` +
            `\`assignee dev setup\` or refresh your AWS session and re-run.`
          );
        }
        unverifiedArns.push({ arn, reason: `verification failed: ${errMsg}` });
      }
    }

    if (unverifiedArns.length > 0) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
        extras: {
          phase: "managed_policy_verification_partial",
          unverifiedCount: unverifiedArns.length,
          unverifiedArns: unverifiedArns.map((u) => `${u.arn}: ${u.reason}`),
        },
      });
    }

    if (invalidArns.length > 0) {
      const lines = invalidArns
        .map((x) => `  - ${x.arn} → ${x.reason}`)
        .join("\n");
      return (
        `One or more ManagedPolicyArns do not exist in IAM:\n${lines}\n\n` +
        `These ARNs were likely hallucinated by the LLM. Either:\n` +
        `  1. Remove them: \`assignee infra apply <intent> --set ManagedPolicyArns=\`\n` +
        `  2. Replace with a verified ARN: see iam-role.ts configHints for the verified list\n` +
        `  3. Specify the policies you want explicitly in your intent (e.g. ` +
        `"... attach the AmazonS3ReadOnlyAccess policy")`
      );
    }
    return null;
  } catch (err) {
    if (isAuthFailureError(err)) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return (
        `AWS credentials expired or invalid — unable to construct IAM client ` +
        `for ManagedPolicyArn verification (${errMsg}). ` +
        `Run \`assignee dev setup\` or refresh your AWS session and re-run.`
      );
    }
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
      extras: {
        phase: "managed_policy_verification_skipped",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

export const managedPolicyGuard: PreflightGuard = {
  id: "managed-policy",
  async run(ctx: GuardContext): Promise<GuardResult> {
    if (ctx.state.resourceType !== "AWS::IAM::Role")
      return skipResult("not an IAM::Role");
    const arns = ctx.desiredState["ManagedPolicyArns"];
    if (!Array.isArray(arns) || arns.length === 0)
      return skipResult("no ManagedPolicyArns");
    const err = await verifyManagedPolicyArns(
      arns.filter((a): a is string => typeof a === "string"),
      ctx.state.config,
    );
    return err ? failResult(err) : passResult;
  },
};
