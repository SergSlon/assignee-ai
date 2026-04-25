/**
 * SDK-direct fallback adapter for AWS::EC2::VPC.
 *
 * W5-04 (P055 → L5-S08): Used when CCAPI is not available in the operator's
 * partition but the EC2 service itself is available.
 *
 * EC2::VPC is often the root resource in compound provisioning plans
 * (VPC → Subnet → IGW → Route Table → Security Group). Getting VPC right
 * unblocks the entire stack in non-commercial partitions.
 *
 * Scope / deferral:
 *   - Creates a VPC with CidrBlock and optional InstanceTenancy.
 *   - EnableDnsHostnames, EnableDnsSupport, Tags mapping are Epic 102+ scope.
 *   - Delete, update, getResource: Epic 102+ for non-commercial.
 *
 * @see https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateVpc.html
 */

import { EC2Client, CreateVpcCommand, type Tenancy } from "@aws-sdk/client-ec2";
import { operatorCredentials } from "../../config/operator-credentials.js";
import { AWS_REGION } from "../../config/constants/aws.js";

/** Synthetic requestToken sentinel — signals immediate success to the poller. */
export const SDK_DIRECT_COMPLETE_TOKEN = "SDK_DIRECT_COMPLETE";

export interface SdkDirectResult {
  requestToken: string;
  identifier: string;
}

/**
 * Creates an EC2 VPC via the direct AWS SDK (not CloudControl).
 *
 * @param desiredStateJson - JSON string of CloudFormation desired-state properties.
 *   Must include `"CidrBlock"` property.
 * @param region           - AWS region for the VPC.
 * @returns SdkDirectResult with a synthetic requestToken + VPC ID identifier.
 * @throws Error with actionable message if CidrBlock is missing or SDK call fails.
 */
export async function createEc2VpcSdkDirect(
  desiredStateJson: string,
  region: string = AWS_REGION,
): Promise<SdkDirectResult> {
  let desiredState: Record<string, unknown>;
  try {
    desiredState = JSON.parse(desiredStateJson) as Record<string, unknown>;
  } catch {
    throw new Error(
      `SDK-direct EC2 VPC create: desiredState is not valid JSON: ${desiredStateJson.slice(0, 120)}`,
    );
  }

  const cidrBlock = desiredState["CidrBlock"];
  if (typeof cidrBlock !== "string" || !cidrBlock) {
    throw new Error(
      `SDK-direct EC2 VPC create: "CidrBlock" is required in desiredState but was not found. ` +
        `Provided keys: ${Object.keys(desiredState).join(", ")}`,
    );
  }

  const instanceTenancy =
    typeof desiredState["InstanceTenancy"] === "string"
      ? (desiredState["InstanceTenancy"] as Tenancy)
      : "default";

  const creds = operatorCredentials();
  const client = new EC2Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });

  const response = await client.send(
    new CreateVpcCommand({
      CidrBlock: cidrBlock,
      InstanceTenancy: instanceTenancy,
    }),
  );

  const vpcId = response.Vpc?.VpcId;
  if (!vpcId) {
    throw new Error(
      `SDK-direct EC2 VPC create: AWS returned no VpcId in the response. ` +
        `The VPC may or may not have been created — check the AWS Console in region ${region}.`,
    );
  }

  return {
    requestToken: SDK_DIRECT_COMPLETE_TOKEN,
    identifier: vpcId,
  };
}
