/**
 * Doctor check #1 — IAM credentials for each Assignee role.
 *
 * Per role: env-var presence, access-key shape, STS reachability,
 * resolved Account + ARN. Operator without env vars is `fail`; reader
 * or auditor without env vars is `warn` (non-blocking).
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  ASSIGNEE_ROLES,
  envVarsForRole,
  tryAssigneeCredentials,
  type AssigneeRole,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import { AWS_REGION } from "../../../config/constants.js";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../types.js";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { maskKey, rollup, withTimeout } from "../util.js";

/** Long-term IAM access key prefix; ASIA = STS session, both accepted. */
const ACCESS_KEY_SHAPE = /^(AKIA|ASIA)[0-9A-Z]{16}$/;

export interface CredentialsCheckDeps {
  stsClientFactory?: (
    creds: ExplicitAwsCredentials,
    region: string,
  ) => {
    send: (cmd: GetCallerIdentityCommand) => Promise<{
      Account?: string;
      Arn?: string;
      UserId?: string;
    }>;
  };
  timeoutMs?: number;
}

/** Pad role names to a fixed width for column alignment. */
function padRole(role: AssigneeRole): string {
  return role.padEnd(8, " ");
}

export async function checkCredentials(
  deps: CredentialsCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const factory =
    deps.stsClientFactory ??
    ((c: ExplicitAwsCredentials, r: string) =>
      new STSClient({
        region: r,
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
        },
      }));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  for (const role of ASSIGNEE_ROLES) {
    const vars = envVarsForRole(role);
    const creds = tryAssigneeCredentials(role);

    if (!creds) {
      subs.push({
        label: padRole(role),
        status: role === "operator" ? "fail" : "warn",
        detail: `not set (${vars.accessKey})`,
      });
      continue;
    }

    if (!ACCESS_KEY_SHAPE.test(creds.accessKeyId)) {
      subs.push({
        label: padRole(role),
        status: "warn",
        detail: `access key shape unusual: ${maskKey(creds.accessKeyId)}`,
      });
      continue;
    }

    try {
      const client = factory(creds, AWS_REGION);
      const result = await withTimeout(
        client.send(new GetCallerIdentityCommand({})),
        timeoutMs,
        `STS for ${role}`,
      );
      if (!result.Account || !result.Arn) {
        subs.push({
          label: padRole(role),
          status: "fail",
          detail: `STS returned empty identity`,
        });
        continue;
      }
      subs.push({
        label: padRole(role),
        status: "ok",
        detail: `${maskKey(creds.accessKeyId)} → ${result.Arn}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      subs.push({
        label: padRole(role),
        status: "fail",
        detail: `STS GetCallerIdentity failed: ${msg}`,
      });
    }
  }

  return {
    name: "Credentials",
    status: rollup(subs),
    subs,
  };
}
