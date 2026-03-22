/**
 * AWS resource discovery for dynamic option elicitation.
 * Fetches real VPCs, subnets, security groups, key pairs, and AMIs
 * from the user's AWS account using the READER credential set.
 *
 * Each function has a 6-second timeout and returns [] on failure.
 * Results are cached per-session to avoid redundant API calls.
 *
 * @see Story 7.11
 */

import {
  EC2Client,
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeKeyPairsCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { withTimeout } from "./timeout.js";

const DISCOVERY_TIMEOUT_MS = 6000;

/** Option shape compatible with ResourceField question options. */
export interface DiscoveryOption {
  value: string;
  label: string;
}

// ── Session cache ────────────────────────────────────────────────────────────
const discoveryCache = new Map<string, DiscoveryOption[]>();

/** Reset cache — used by tests and when region changes. */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

async function cachedDiscover(
  key: string,
  fetcher: () => Promise<DiscoveryOption[]>,
): Promise<DiscoveryOption[]> {
  const cached = discoveryCache.get(key);
  if (cached) return cached;

  try {
    const results = await fetcher();
    if (results.length > 0) {
      discoveryCache.set(key, results);
    }
    return results;
  } catch {
    // Discovery is best-effort — callers fall back to manual entry.
    return [];
  }
}

// ── Shared client factory ────────────────────────────────────────────────────

function readerCredentials(): {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
} {
  return {
    accessKeyId: process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] ?? "",
    region: process.env["AWS_REGION"] ?? "us-east-1",
  };
}

function createEc2Client(): EC2Client {
  const creds = readerCredentials();
  return new EC2Client({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

function createSsmClient(): SSMClient {
  const creds = readerCredentials();
  return new SSMClient({
    region: creds.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

// ── Discovery functions ──────────────────────────────────────────────────────

/**
 * Discovers latest AMIs via SSM public parameters.
 * Fetches Amazon Linux 2023, Ubuntu 22.04, Ubuntu 24.04, Windows Server 2022.
 */
export async function discoverAmis(): Promise<DiscoveryOption[]> {
  return cachedDiscover("amis", async () => {
    const ssm = createSsmClient();
    const params: Array<{ path: string; label: string }> = [
      {
        path: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        label: "Amazon Linux 2023",
      },
      {
        path: "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
        label: "Ubuntu 22.04 LTS",
      },
      {
        path: "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
        label: "Ubuntu 24.04 LTS",
      },
      {
        path: "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base",
        label: "Windows Server 2022",
      },
    ];

    const results = await Promise.allSettled(
      params.map(async ({ path, label }) => {
        const result = await withTimeout(
          ssm.send(new GetParameterCommand({ Name: path })),
          DISCOVERY_TIMEOUT_MS,
        );
        if (!result?.Parameter?.Value) return null;
        const amiId = result.Parameter.Value;
        return { value: amiId, label: `${label} (${amiId})` };
      }),
    );

    const options: DiscoveryOption[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        options.push(r.value);
      }
    }
    return options;
  });
}

/**
 * Discovers VPC subnets from the account.
 * Shows Name tag, CIDR block, and availability zone.
 */
export async function discoverSubnets(): Promise<DiscoveryOption[]> {
  return cachedDiscover("subnets", async () => {
    const ec2 = createEc2Client();
    const result = await withTimeout(
      ec2.send(new DescribeSubnetsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.Subnets) return [];

    return result.Subnets.map((subnet) => {
      const nameTag = subnet.Tags?.find((t) => t.Key === "Name")?.Value;
      const label = nameTag
        ? `${nameTag} (${subnet.CidrBlock}, ${subnet.AvailabilityZone}) — ${subnet.SubnetId}`
        : `${subnet.SubnetId} (${subnet.CidrBlock}, ${subnet.AvailabilityZone})`;
      return { value: subnet.SubnetId!, label };
    }).filter((o) => o.value);
  });
}

/**
 * Discovers security groups from the account.
 * Shows group name and description.
 */
export async function discoverSecurityGroups(): Promise<DiscoveryOption[]> {
  return cachedDiscover("security-groups", async () => {
    const ec2 = createEc2Client();
    const result = await withTimeout(
      ec2.send(new DescribeSecurityGroupsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.SecurityGroups) return [];

    return result.SecurityGroups.filter((sg) => sg.GroupName !== "default")
      .map((sg) => {
        const desc =
          sg.Description && sg.Description !== sg.GroupName
            ? ` — ${sg.Description}`
            : "";
        return {
          value: sg.GroupId!,
          label: `${sg.GroupName}${desc} (${sg.GroupId})`,
        };
      })
      .filter((o) => o.value);
  });
}

/**
 * Discovers EC2 key pairs from the account.
 * Prepends a "None (SSM access only)" option.
 */
export async function discoverKeyPairs(): Promise<DiscoveryOption[]> {
  return cachedDiscover("key-pairs", async () => {
    const ec2 = createEc2Client();
    const result = await withTimeout(
      ec2.send(new DescribeKeyPairsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    if (!result?.KeyPairs) return [];

    const options: DiscoveryOption[] = [
      { value: "", label: "None (SSM access only)" },
    ];
    for (const kp of result.KeyPairs) {
      if (kp.KeyName) {
        const keyType = kp.KeyType ?? "unknown";
        options.push({
          value: kp.KeyName,
          label: `${kp.KeyName} (${keyType})`,
        });
      }
    }
    return options;
  });
}
