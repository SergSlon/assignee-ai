import { RESOURCE_TYPES, COMPANION_RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/**
 * ResourcePlugin for AWS::EC2::RouteTable.
 * Route tables are free — no AWS charges apply.
 *
 * toCfn() generates both the RouteTable and a SubnetRouteTableAssociation,
 * since a route table without a subnet association serves no purpose.
 */
export const routeTablePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
  commonFields: [
    {
      name: "VpcId",
      required: true,
      question: {
        type: "enum",
        label: "VPC",
        hint: "The VPC this route table belongs to. Every route table is scoped to exactly one VPC.",
        fetcher: "discover-vpcs",
        options: [],
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:platform",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
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
  advancedFields: [],
  defaults: {},
  configHints: [
    "VpcId MUST reference a valid VPC in the plan",
    `${COMPANION_RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION} is IMMUTABLE — any change triggers resource replacement (no in-place update supported by CloudFormation)`,
    "Every route table should be explicitly associated with at least one subnet; avoid relying on the VPC main route table",
    "Public route tables need a 0.0.0.0/0 route targeting an InternetGateway; private route tables use a NatGateway",
  ],
  toCfn(desiredState: Record<string, unknown>): CfnOutput[] {
    const logicalId = (desiredState["logicalId"] as string) ?? "RouteTable";
    const subnetId = desiredState["SubnetId"] as string | undefined;

    const routeTableResource: CfnOutput = {
      logicalId,
      type: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      properties: {
        VpcId: desiredState["VpcId"],
        ...(desiredState["Tags"] ? { Tags: desiredState["Tags"] } : {}),
      },
    };

    const resources: CfnOutput[] = [routeTableResource];

    if (subnetId) {
      resources.push({
        logicalId: `${logicalId}SubnetAssociation`,
        type: COMPANION_RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
        properties: {
          RouteTableId: { Ref: logicalId },
          SubnetId: subnetId,
        },
      });
    }

    return resources;
  },
};
