/**
 * EC2 network-resource discovery: VPC subnets, security groups, key pairs.
 */

import {
  DescribeSubnetsCommand,
  DescribeSecurityGroupsCommand,
  DescribeKeyPairsCommand,
} from "@aws-sdk/client-ec2";
import { DiscoveryCacheKey } from "@assignee/core";
import { withTimeout } from "../timeout.js";
import { cachedDiscover } from "./cache.js";
import { createEc2Client } from "./clients.js";
import { DISCOVERY_TIMEOUT_MS, type DiscoveryOption } from "./types.js";

/**
 * Discovers VPC subnets from the account.
 * Shows Name tag, CIDR block, and availability zone.
 */
export async function discoverSubnets(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.SUBNETS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
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
  return cachedDiscover(DiscoveryCacheKey.SECURITY_GROUPS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
    const result = await withTimeout(
      ec2.send(new DescribeSecurityGroupsCommand({})),
      DISCOVERY_TIMEOUT_MS,
    );
    // Prepend "None" option — VPC default SG is used when no SG is selected
    const options: DiscoveryOption[] = [
      { value: "", label: "None (use VPC default security group)" },
    ];
    if (!result?.SecurityGroups) return options;

    for (const sg of result.SecurityGroups) {
      if (sg.GroupName === "default" || !sg.GroupId) continue;
      const desc =
        sg.Description && sg.Description !== sg.GroupName
          ? ` — ${sg.Description}`
          : "";
      options.push({
        value: sg.GroupId,
        label: `${sg.GroupName}${desc} (${sg.GroupId})`,
      });
    }
    return options;
  });
}

/**
 * Discovers EC2 key pairs from the account.
 * Prepends a "None (SSM access only)" option.
 */
export async function discoverKeyPairs(): Promise<DiscoveryOption[]> {
  return cachedDiscover(DiscoveryCacheKey.KEY_PAIRS, async () => {
    const ec2 = createEc2Client();
    if (!ec2) return []; // Graceful no-op: reader creds not configured
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
