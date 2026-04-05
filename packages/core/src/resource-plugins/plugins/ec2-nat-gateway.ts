import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::EC2::NatGateway.
 * NatGateway provides outbound internet access for private subnets.
 * When ConnectivityType is "public", toCfn() auto-provisions a companion EIP.
 *
 * @see Story 25.4 — NatGateway Plugin + Pricing + BP Rules
 */
export const natGatewayPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
  commonFields: [
    {
      name: CfnKey.SUBNET_ID,
      required: true,
      question: {
        type: "enum",
        label: "Subnet",
        hint: "Must be a public subnet (with route to Internet Gateway). Placing in a private subnet will prevent outbound internet access. Private subnets should route 0.0.0.0/0 through the NatGateway, not host it.",
        placeholder: "subnet-0abc1234",
        options: [],
        fetcher: "discover-subnets",
      },
    },
    {
      name: CfnKey.CONNECTIVITY_TYPE,
      question: {
        type: "enum",
        label: "Connectivity type",
        hint: "Public: allows private subnet resources to reach the internet (requires EIP, auto-provisioned). Private: enables communication between VPCs or on-premises networks without internet access — no EIP needed, no data processing charges for inter-AZ traffic.",
        options: [
          {
            value: AwsDefault.CONNECTIVITY_PUBLIC,
            label: "Public — outbound internet access (requires EIP)",
            recommended: true,
          },
          {
            value: AwsDefault.CONNECTIVITY_PRIVATE,
            label: "Private — VPC-to-VPC / on-premises only (no EIP)",
          },
        ],
        initialValue: AwsDefault.CONNECTIVITY_PUBLIC,
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:platform",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: CfnKey.MAX_DRAIN_DURATION,
      question: {
        type: "string",
        label: "Max drain duration (seconds)",
        placeholder: "350",
        initialValue: "350",
        hint: "Maximum time (in seconds) to wait for active connections to drain before forcibly closing them when deleting the NatGateway. Default is 350 seconds.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = parseInt(String(value), 10);
          if (isNaN(n) || n < 1 || n > 4000)
            return "Must be between 1 and 4000 seconds";
          return undefined;
        },
      },
    },
  ],
  defaults: {
    [CfnKey.CONNECTIVITY_TYPE]: AwsDefault.CONNECTIVITY_PUBLIC,
  },
  configHints: [
    "NatGateway SubnetId: REQUIRED. The NatGateway MUST be placed in a public subnet (one with a route to an InternetGateway). Placing it in a private subnet will not work.",
    "NatGateway AllocationId: When ConnectivityType is 'public', you MUST include AllocationId in the output. Set it to 'AUTO_ALLOCATE_EIP' — the provisioner will replace it with a real EIP at runtime. NEVER omit AllocationId for public NatGateway.",
    "NatGateway ConnectivityType: defaults to 'public'. Only set to 'private' if the user explicitly requests private connectivity (no internet egress).",
    "NatGateway cost: significant cost driver — hourly charges (~$0.045/hr ≈ ~$32/month) PLUS per-GB data processing fees apply even with zero traffic. Consider VPC endpoints for S3/DynamoDB to reduce data processing costs.",
    "NatGateway HA: For production, deploy one NatGateway per AZ to avoid cross-AZ single point of failure. Each NatGateway needs its own EIP.",
    "NatGateway MaxDrainDurationSeconds: if not specified, OMIT — default 350 seconds applies automatically.",
  ],
  toCfn(desiredState: Record<string, unknown>) {
    const connectivityType =
      (desiredState[CfnKey.CONNECTIVITY_TYPE] as string) ??
      AwsDefault.CONNECTIVITY_PUBLIC;
    const subnetId = desiredState[CfnKey.SUBNET_ID] as string | undefined;
    const tags = desiredState[CfnKey.TAGS] as unknown;
    const maxDrain = desiredState[CfnKey.MAX_DRAIN_DURATION] as
      | string
      | undefined;

    const logicalPrefix =
      (desiredState[CfnKey._LOGICAL_ID] as string) ?? "NatGateway";

    const natGwProps: Record<string, unknown> = {
      [CfnKey.CONNECTIVITY_TYPE]: connectivityType,
    };

    if (subnetId) {
      natGwProps[CfnKey.SUBNET_ID] = subnetId;
    }
    if (tags) {
      natGwProps[CfnKey.TAGS] = tags;
    }
    if (maxDrain) {
      natGwProps[CfnKey.MAX_DRAIN_DURATION] = parseInt(maxDrain, 10);
    }

    const resources: CfnOutput[] = [];

    if (connectivityType === AwsDefault.CONNECTIVITY_PUBLIC) {
      // Auto-provision an Elastic IP for public NAT Gateway
      const eipLogicalId = `${logicalPrefix}EIP`;
      resources.push({
        logicalId: eipLogicalId,
        type: COMPANION_RESOURCE_TYPES.EC2_EIP,
        properties: {
          [CfnKey.DOMAIN]: "vpc",
          ...(tags ? { [CfnKey.TAGS]: tags } : {}),
        },
      });

      // Wire AllocationId to the EIP via !GetAtt
      natGwProps[CfnKey.ALLOCATION_ID] = {
        "Fn::GetAtt": [eipLogicalId, CfnKey.ALLOCATION_ID],
      };
    }

    resources.push({
      logicalId: logicalPrefix,
      type: RESOURCE_TYPES.EC2_NAT_GATEWAY,
      properties: natGwProps,
    });

    return resources;
  },
};
