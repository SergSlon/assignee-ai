/**
 * AMI discovery — latest Amazon/Ubuntu/Windows AMIs via SSM public
 * parameters, plus free-text AMI search via DescribeImages.
 */

import { DescribeImagesCommand } from "@aws-sdk/client-ec2";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { AmiOs, DiscoveryCacheKey } from "@assignee/core";
import { withTimeout } from "../timeout.js";
import { PromiseStatus } from "../../config/constants.js";
import { cachedDiscover } from "./cache.js";
import { createEc2Client, createSsmClient } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers latest AMIs via SSM public parameters.
 * Fetches Amazon Linux 2023, Ubuntu 22.04, Ubuntu 24.04, Windows Server 2022.
 */
export async function discoverAmis(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.AMIS, async () => {
    const ssm = createSsmClient();
    if (!ssm) return []; // Graceful no-op: reader creds not configured
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
      if (r.status === PromiseStatus.FULFILLED && r.value) {
        options.push(r.value);
      }
    }
    return options;
  });
}

/**
 * OS name → SSM parameter path mapping for AMI resolution.
 * Used when the user picks an OS from the static fallback menu
 * instead of a real AMI ID (discovery failed).
 */
const OS_TO_SSM_PATH: Record<string, string> = {
  [AmiOs.AMAZON_LINUX_2023]:
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  [AmiOs.UBUNTU_24]:
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
  [AmiOs.UBUNTU_22]:
    "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
  [AmiOs.WINDOWS_2022]:
    "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base",
};

/**
 * Resolves an OS name (e.g., "amazon-linux-2023") to a real AMI ID
 * via a targeted SSM parameter lookup. Returns null on failure.
 */
export async function resolveAmiFromOsName(
  osName: string,
): Promise<string | null> {
  const ssmPath = OS_TO_SSM_PATH[osName];
  if (!ssmPath) return null;

  try {
    const ssm = createSsmClient();
    if (!ssm) return null; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ssm.send(new GetParameterCommand({ Name: ssmPath })),
      DISCOVERY_TIMEOUT_MS,
    );
    return result?.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/**
 * Searches for AMIs matching a user description (e.g., "deep learning", "ML training").
 * Uses ec2:DescribeImages filtered to Amazon-owned, available, public images.
 * Returns top 5 results as DiscoveryOption[]. Cached per query string.
 */
export async function searchAmis(query: string): Promise<DiscoveryOption[]> {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];

  const cacheKey = `search-amis-${normalizedQuery}`;
  return cachedDiscover(cacheKey, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured

    // Build wildcard pattern from query words: "ML training" → "*ml*training*"
    const words = normalizedQuery.split(/\s+/).filter(Boolean);
    const namePattern = `*${words.join("*")}*`;

    const result = await withTimeout(
      ec2.send(
        new DescribeImagesCommand({
          Filters: [
            { Name: "name", Values: [namePattern] },
            { Name: "state", Values: ["available"] },
            { Name: "is-public", Values: ["true"] },
          ],
          Owners: ["amazon"],
        }),
      ),
      DISCOVERY_TIMEOUT_MS,
    );

    if (!result?.Images || result.Images.length === 0) return [];

    // Sort by creation date (newest first) and take top 5
    const sorted = result.Images.sort((a, b) => {
      const dateA = a.CreationDate ?? "";
      const dateB = b.CreationDate ?? "";
      return dateB.localeCompare(dateA);
    }).slice(0, 5);

    return sorted
      .filter((img) => img.ImageId)
      .map((img) => ({
        value: img.ImageId!,
        label: `${img.Name ?? "Unnamed AMI"} \u2014 ${img.ImageId}`,
      }));
  });
}
