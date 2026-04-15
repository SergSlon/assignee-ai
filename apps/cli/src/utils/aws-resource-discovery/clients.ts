/**
 * AWS SDK client factories for discovery.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * GRACEFUL DEGRADATION CONTRACT
 * ──────────────────────────────────────────────────────────────────────────
 * Discovery is a best-effort, read-only feature used by the option-elicitor
 * to populate dropdowns (subnets, AMIs, key pairs, RDS classes, etc.). A user
 * running `assignee plan` with only operator credentials configured — but no
 * reader credentials — must still be able to run the wizard with manual-entry
 * fallbacks. We therefore use `tryAssigneeCredentials` (non-throwing) and
 * return `undefined` so each discover*() function can short-circuit to `[]`
 * before ever constructing an SDK client.
 *
 * SECURITY: never falls through to `~/.aws/credentials`, SSO, or IMDS. When
 * reader env vars are unset, the SDK client is simply not built — no empty
 * credentials are ever sent to AWS, and no ambient AWS_* shell vars are
 * honored.
 */

import { EC2Client } from "@aws-sdk/client-ec2";
import { RDSClient } from "@aws-sdk/client-rds";
import { SSMClient } from "@aws-sdk/client-ssm";
import { AWS_REGION } from "../../config/constants.js";
import {
  tryAssigneeCredentials,
  type ExplicitAwsCredentials,
} from "../../config/aws-credentials.js";

function readerCredsOrUndefined(): ExplicitAwsCredentials | undefined {
  return tryAssigneeCredentials("reader");
}

export function createEc2Client(): EC2Client | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new EC2Client({
    region: AWS_REGION,
    credentials: creds,
  });
}

export function createSsmClient(): SSMClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new SSMClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

export function createRdsClient(): RDSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new RDSClient({
    region: AWS_REGION,
    credentials: creds,
  });
}
