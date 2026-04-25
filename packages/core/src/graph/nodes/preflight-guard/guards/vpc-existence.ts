/**
 * Guard: verify a plan-referenced VPC actually exists via
 * `ec2:DescribeVpcs` (Epic 92 finding B-10).
 *
 * Problem: `assignee plan "Create a subnet in a nonexistent VPC
 * vpc-doesnotexist99999" --output json --no-apply` emits a plan with
 * that bogus VpcId and FULFILLED preflight; CloudControl later
 * rejects on apply. This guard short-circuits that path before any
 * side effects.
 *
 * Behaviour (mirrors `managed-policy.ts` for consistency across the
 * preflight registry — fail-closed on auth expiry, tolerant of
 * AccessDenied and Throttling, opt-in strict for unknowns):
 *
 *   - Fail-CLOSED on AWS session-auth failure (ExpiredToken,
 *     InvalidClientTokenId, SignatureDoesNotMatch, etc.).
 *   - AccessDenied → WARN + unverified + pass (operator may lack
 *     `ec2:DescribeVpcs` in a least-privilege setup; blocking here
 *     would break legitimate workflows). Logged via the standard
 *     preflight-completed action.
 *   - Throttling → retry 3× with 200/500/1200ms backoff; give up as
 *     unverified+WARN.
 *   - Unknown errors → WARN + unverified + pass (default) OR fail-
 *     closed when `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1` (SaaS /
 *     regulated-tenant posture).
 *   - `InvalidVpcID.NotFound` → FAIL with actionable error.
 *
 * Scope: the guard skips when
 *   - `ctx.desiredState.VpcId` is absent / not a string / empty, OR
 *   - the VpcId looks like a Ref intrinsic (starts with `!Ref ` or is
 *     a CloudFormation parameter token `{"Ref":...}`), OR
 *   - the VpcId ALREADY failed the `placeholder-resource-id` guard
 *     (in that case we never reach here because the registry places
 *     `placeholder-resource-id` BEFORE this guard and short-circuits
 *     on fail).
 *
 * Dependency injection: the EC2 client factory is parameterised on
 * the guard so tests can swap in a stub. Production default is
 * `createEC2Client` from the single grep anchor.
 */
import type { EC2Client, EC2ClientConfig } from "@aws-sdk/client-ec2";
import {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "@/index.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { EnvVar } from "@/constants/env-vars.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import type { GuardContext, GuardResult, PreflightGuard } from "../types.js";
import { failResult, passResult, skipResult } from "../types.js";

const THROTTLE_BACKOFF_MS = [200, 500, 1200] as const;

/** Minimal EC2 client surface we depend on. Keeps the tests small. */
export interface VpcExistenceClient {
  describeVpcs(args: {
    VpcIds: string[];
  }): Promise<{ Vpcs?: Array<{ VpcId?: string }> }>;
  destroy?(): void;
}

/**
 * Factory for the production EC2 client. Exported so the test harness
 * can replace it via the `clientFactory` argument of
 * `buildVpcExistenceGuard`.
 */
export async function defaultVpcExistenceClientFactory(): Promise<VpcExistenceClient> {
  const { DescribeVpcsCommand } = await import("@aws-sdk/client-ec2");
  const { createEC2Client } = await import("@/aws/ec2-client-factory.js");
  const { operatorCredentials } =
    await import("@/config/operator-credentials.js");
  const creds = operatorCredentials();
  const config: EC2ClientConfig = {
    region: AWS_REGION,
    ...(creds.accessKeyId && creds.secretAccessKey
      ? {
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            // W2-01: pass session token for STS/SSO short-term credentials.
            ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
          },
        }
      : {}),
  };
  const ec2: EC2Client = createEC2Client(config);
  return {
    async describeVpcs(args) {
      return ec2.send(new DescribeVpcsCommand(args));
    },
    destroy: () => ec2.destroy(),
  };
}

/**
 * Real AWS VPC IDs come in exactly two shapes:
 *   - 8-char legacy hex (`vpc-12345678`) — grandfathered accounts
 *   - 17-char modern hex (`vpc-0a1b2c3d4e5f67890`) — default since 2018
 *
 * Anything else is a test contrivance or typo and the SDK would reject
 * as `InvalidVpcID.Malformed` anyway. Skipping these values avoids
 * hammering AWS on every integration test that uses `vpc-123` as a
 * placeholder fixture.
 *
 * Exported for unit tests.
 */
export const REAL_VPC_ID_REGEX = /^vpc-(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{17})$/;

/** Scan state for a VpcId string that's worth verifying. */
export function findVerifiableVpcId(
  desiredState: Record<string, unknown>,
): string | undefined {
  const raw = desiredState["VpcId"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // Skip CFN intrinsic references (the real ID is resolved at apply).
  if (trimmed.startsWith("!Ref ")) return undefined;
  // Only genuine AWS VPC ID shapes are worth sending to DescribeVpcs —
  // anything else (ARN, random token, truncated test fixture) would
  // just come back InvalidVpcID.Malformed, which is a different
  // problem class. See REAL_VPC_ID_REGEX above.
  if (!REAL_VPC_ID_REGEX.test(trimmed)) return undefined;
  return trimmed;
}

export interface VpcExistenceOptions {
  readonly clientFactory?: () => Promise<VpcExistenceClient>;
}

/**
 * Build the guard with an injectable client factory. The default
 * production registry (`registry.ts`) uses the stock factory; tests
 * swap in a stub.
 */
export function buildVpcExistenceGuard(
  options: VpcExistenceOptions = {},
): PreflightGuard {
  const factory = options.clientFactory ?? defaultVpcExistenceClientFactory;

  return {
    id: "vpc-existence",
    async run(ctx: GuardContext): Promise<GuardResult> {
      const vpcId = findVerifiableVpcId(ctx.desiredState);
      if (!vpcId) return skipResult("no verifiable VpcId in desiredState");

      let client: VpcExistenceClient;
      try {
        client = await factory();
      } catch (err) {
        if (isAuthFailureError(err)) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return failResult(
            `AWS credentials expired or invalid — unable to construct EC2 client ` +
              `for VPC existence check (${errMsg}). ` +
              `Run \`assignee setup\` or refresh your AWS session and re-run.`,
          );
        }
        log({
          ts: new Date().toISOString(),
          runId: ctx.state.runId ?? "system",
          level: "warn",
          action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
          extras: {
            phase: "vpc_existence_skipped",
            reason: "client_construction_failed",
            error: err instanceof Error ? err.message : String(err),
          },
        });
        return passResult;
      }

      try {
        let attempt = 0;
        for (;;) {
          try {
            const result = await client.describeVpcs({ VpcIds: [vpcId] });
            const found = (result.Vpcs ?? []).some((v) => v.VpcId === vpcId);
            if (!found) {
              return failResult(buildNotFoundMessage(vpcId));
            }
            return passResult;
          } catch (err) {
            // InvalidVpcID.NotFound → the VPC does not exist in this
            // account/region. This is the Epic 92 B-10 class: fail
            // with an actionable error.
            const e = err as { name?: string; Code?: string };
            const errName = e?.name ?? "";
            const errCode = e?.Code ?? "";
            if (
              errName === "InvalidVpcID.NotFound" ||
              errCode === "InvalidVpcID.NotFound"
            ) {
              return failResult(buildNotFoundMessage(vpcId));
            }
            // Malformed IDs come back as InvalidVpcID.Malformed — that's
            // a stronger signal than NotFound that the value is a
            // placeholder; treat identically.
            if (
              errName === "InvalidVpcID.Malformed" ||
              errCode === "InvalidVpcID.Malformed"
            ) {
              return failResult(buildMalformedMessage(vpcId));
            }
            if (isAuthFailureError(err)) {
              const errMsg = err instanceof Error ? err.message : String(err);
              return failResult(
                `AWS credentials expired or invalid while verifying ` +
                  `VpcId ${vpcId} (${errName || errCode || "auth failure"}: ${errMsg}). ` +
                  `Preflight cannot validate the plan without working ` +
                  `credentials. Run \`assignee setup\` or refresh your AWS ` +
                  `session (e.g. \`aws sso login\`) and re-run.`,
              );
            }
            if (isAccessDeniedError(err)) {
              log({
                ts: new Date().toISOString(),
                runId: ctx.state.runId ?? "system",
                level: "warn",
                action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
                extras: {
                  phase: "vpc_existence_unverified",
                  reason: "access_denied_ec2_describe_vpcs",
                  vpcId,
                },
              });
              return passResult;
            }
            if (
              isThrottlingError(err) &&
              attempt < THROTTLE_BACKOFF_MS.length
            ) {
              await new Promise((r) =>
                setTimeout(r, THROTTLE_BACKOFF_MS[attempt]!),
              );
              attempt += 1;
              continue;
            }
            if (isThrottlingError(err)) {
              log({
                ts: new Date().toISOString(),
                runId: ctx.state.runId ?? "system",
                level: "warn",
                action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
                extras: {
                  phase: "vpc_existence_unverified",
                  reason: `throttled_after_${attempt + 1}_attempts`,
                  vpcId,
                },
              });
              return passResult;
            }
            // Story 48.3 parity: opt-in strict mode blocks on unknown;
            // default is WARN + pass to preserve local-CLI UX.
            if (process.env[EnvVar.ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS] === "1") {
              const errMsg = err instanceof Error ? err.message : String(err);
              return failResult(
                `Preflight unknown error while verifying VpcId ${vpcId} ` +
                  `(${errName || errCode || "unknown"}): ${errMsg}. ` +
                  `Strict mode is enabled via ` +
                  `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1 — unset that env var ` +
                  `to fall back to WARN-only behaviour.`,
              );
            }
            log({
              ts: new Date().toISOString(),
              runId: ctx.state.runId ?? "system",
              level: "warn",
              action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
              extras: {
                phase: "vpc_existence_unverified",
                reason: "unknown_error",
                vpcId,
                error: err instanceof Error ? err.message : String(err),
              },
            });
            return passResult;
          }
        }
      } finally {
        if (typeof client.destroy === "function") {
          try {
            client.destroy();
          } catch {
            // best-effort cleanup; EC2 client destroy throwing should
            // never itself break a plan.
          }
        }
      }
    },
  };
}

function buildNotFoundMessage(vpcId: string): string {
  return (
    `VpcId ${vpcId} does not exist in the current account/region ` +
    `(${AWS_REGION}). Either:\n` +
    `  1. Create the VPC first via a compound pattern ` +
    `(e.g. \`assignee plan "Create a VPC with public and private subnets"\`).\n` +
    `  2. List existing VPCs with ` +
    `\`aws ec2 describe-vpcs --query 'Vpcs[].VpcId'\` and re-run with ` +
    `--set VpcId=<real-id>.\n` +
    `  3. Omit the VpcId and let the provisioner derive it from the ` +
    `compound pattern.`
  );
}

function buildMalformedMessage(vpcId: string): string {
  return (
    `VpcId ${vpcId} is malformed. AWS expects an ID of the form ` +
    `\`vpc-<hex>\` (e.g. \`vpc-0a1b2c3d4e5f67890\`). Either:\n` +
    `  1. Provide a real VpcId from your account ` +
    `(\`aws ec2 describe-vpcs --query 'Vpcs[].VpcId'\`).\n` +
    `  2. Omit the field entirely and let the provisioner derive it.`
  );
}

/**
 * Default (production) guard instance using the stock EC2 client
 * factory. Registered in `registry.ts`.
 */
export const vpcExistenceGuard: PreflightGuard = buildVpcExistenceGuard();
