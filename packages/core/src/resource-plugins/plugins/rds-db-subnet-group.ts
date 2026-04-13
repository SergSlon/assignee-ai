import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::RDS::DBSubnetGroup.
 *
 * A DB subnet group is required whenever an RDS instance is launched in a
 * non-default VPC. It groups 2+ subnets spanning at least 2 AZs so that
 * RDS can place the primary and standby instances for Multi-AZ deployments.
 *
 * CCAPI schema:
 *   - primaryIdentifier: /properties/DBSubnetGroupName
 *   - required: [DBSubnetGroupDescription, SubnetIds]
 *   - createOnly: [DBSubnetGroupName]
 *   - tagging: { taggable: true, tagOnCreate: true }
 *   - handlers: create, read, update, delete, list (all present)
 *
 * Pricing: free (no direct charge; RDS instance itself is billed).
 */
export const rdsDbSubnetGroupPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
  commonFields: [
    {
      name: CfnKey.DB_SUBNET_GROUP_DESCRIPTION,
      question: {
        type: "string",
        label: "Subnet group description",
        placeholder: "Subnets for my RDS database",
        hint: "A human-readable description of the DB subnet group. Required by CCAPI.",
        validate: (value: unknown) => {
          if (!value || String(value).trim().length === 0)
            return "Description is required";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:backend",
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
  advancedFields: [],
  defaults: {},
  configHints: [
    "DBSubnetGroupDescription is required — provide a descriptive name for the group.",
    "SubnetIds must reference 2+ subnets spanning at least 2 Availability Zones.",
    "DBSubnetGroupName is optional and immutable — if omitted, CloudFormation auto-generates a name.",
    "DB subnet groups have no direct cost — all charges come from the RDS instance.",
  ],
};
