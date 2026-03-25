import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";

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
      name: "SubnetId",
      required: true,
      question: {
        type: "enum",
        label: "Subnet",
        hint: "NatGateway MUST be placed in a public subnet (one with a route to an InternetGateway). Private subnets route 0.0.0.0/0 through the NatGateway.",
        placeholder: "subnet-0abc1234",
        options: [],
        fetcher: "discover-subnets",
      },
    },
    {
      name: "ConnectivityType",
      question: {
        type: "enum",
        label: "Connectivity type",
        hint: "Public: allows private subnet resources to reach the internet (requires EIP, auto-provisioned). Private: enables communication between VPCs or on-premises networks without internet access — no EIP needed, no data processing charges for inter-AZ traffic.",
        options: [
          {
            value: "public",
            label: "Public — outbound internet access (requires EIP)",
            recommended: true,
          },
          {
            value: "private",
            label: "Private — VPC-to-VPC / on-premises only (no EIP)",
          },
        ],
        initialValue: "public",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:platform",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [
    {
      name: "MaxDrainDurationSeconds",
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
    ConnectivityType: "public",
  },
  configHints: [
    "NatGateway SubnetId: REQUIRED. The NatGateway MUST be placed in a public subnet (one with a route to an InternetGateway). Placing it in a private subnet will not work.",
    "NatGateway AllocationId: When ConnectivityType is 'public', you MUST include AllocationId in the output. Set it to 'AUTO_ALLOCATE_EIP' — the provisioner will replace it with a real EIP at runtime. NEVER omit AllocationId for public NatGateway.",
    "NatGateway ConnectivityType: defaults to 'public'. Only set to 'private' if the user explicitly requests private connectivity (no internet egress).",
    "NatGateway cost: significant cost driver — hourly charges (~$0.045/hr ≈ $32/month) PLUS per-GB data processing fees apply even with zero traffic. Consider VPC endpoints for S3/DynamoDB to reduce data processing costs.",
    "NatGateway HA: For production, deploy one NatGateway per AZ to avoid cross-AZ single point of failure. Each NatGateway needs its own EIP.",
    "NatGateway MaxDrainDurationSeconds: if not specified, OMIT — default 350 seconds applies automatically.",
  ],
  toCfn(desiredState: Record<string, unknown>) {
    const connectivityType =
      (desiredState["ConnectivityType"] as string) ?? "public";
    const subnetId = desiredState["SubnetId"] as string | undefined;
    const tags = desiredState["Tags"] as unknown;
    const maxDrain = desiredState["MaxDrainDurationSeconds"] as
      | string
      | undefined;

    const logicalPrefix =
      (desiredState["_logicalId"] as string) ?? "NatGateway";

    const natGwProps: Record<string, unknown> = {
      ConnectivityType: connectivityType,
    };

    if (subnetId) {
      natGwProps["SubnetId"] = subnetId;
    }
    if (tags) {
      natGwProps["Tags"] = tags;
    }
    if (maxDrain) {
      natGwProps["MaxDrainDurationSeconds"] = parseInt(maxDrain, 10);
    }

    const resources: CfnOutput[] = [];

    if (connectivityType === "public") {
      // Auto-provision an Elastic IP for public NAT Gateway
      const eipLogicalId = `${logicalPrefix}EIP`;
      resources.push({
        logicalId: eipLogicalId,
        type: "AWS::EC2::EIP",
        properties: {
          Domain: "vpc",
          ...(tags ? { Tags: tags } : {}),
        },
      });

      // Wire AllocationId to the EIP via !GetAtt
      natGwProps["AllocationId"] = {
        "Fn::GetAtt": [eipLogicalId, "AllocationId"],
      };
    }

    resources.push({
      logicalId: logicalPrefix,
      type: "AWS::EC2::NatGateway",
      properties: natGwProps,
    });

    return resources;
  },
};
