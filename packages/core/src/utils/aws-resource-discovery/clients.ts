/**
 * AWS SDK client factories for discovery.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * GRACEFUL DEGRADATION CONTRACT
 * ──────────────────────────────────────────────────────────────────────────
 * Discovery is a best-effort, read-only feature used by the option-elicitor
 * to populate dropdowns (subnets, AMIs, key pairs, RDS classes, etc.). A user
 * running `assignee infra plan` with only operator credentials configured — but no
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

import { createEC2Client, type EC2Client } from "../../aws/index.js";
import { RDSClient } from "@aws-sdk/client-rds";
import { SSMClient } from "@aws-sdk/client-ssm";
import { EFSClient } from "@aws-sdk/client-efs";
import { KMSClient } from "@aws-sdk/client-kms";
import { SNSClient } from "@aws-sdk/client-sns";
import { ECSClient } from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { AWS_REGION } from "../../config/constants/aws.js";
import {
  tryAssigneeCredentials,
  type ExplicitAwsCredentials,
} from "../../config/aws-credentials.js";

function readerCredsOrUndefined(): ExplicitAwsCredentials | undefined {
  return tryAssigneeCredentials("reader");
}

export function createEc2Client(region?: string): EC2Client | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return createEC2Client({
    region: region ?? AWS_REGION,
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

export function createRdsClient(region?: string): RDSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new RDSClient({
    region: region ?? AWS_REGION,
    credentials: creds,
  });
}

export function createEfsClient(): EFSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new EFSClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

export function createKmsClient(): KMSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new KMSClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

export function createSnsClient(): SNSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new SNSClient({
    region: AWS_REGION,
    credentials: creds,
  });
}

export function createEcsClient(region?: string): ECSClient | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new ECSClient({
    region: region ?? AWS_REGION,
    credentials: creds,
  });
}

export function createElbClient(
  region?: string,
): ElasticLoadBalancingV2Client | undefined {
  const creds = readerCredsOrUndefined();
  if (!creds) return undefined;
  return new ElasticLoadBalancingV2Client({
    region: region ?? AWS_REGION,
    credentials: creds,
  });
}
