/**
 * Reader role policy generator.
 * Read-only: CloudFormation schema read, Pricing API read, Cost Explorer read.
 *
 * Split out of `iam-policies.ts` for SRP.
 */

import { IamEffect } from "../iam-effects.js";
import { IamPolicy, IamAction } from "../aws-arns.js";
import type { PolicyDocument } from "./types.js";

export function readerPolicy(): PolicyDocument {
  return {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "CloudFormationSchemaRead",
        Effect: IamEffect.ALLOW,
        Action: [IamAction.CFN_DESCRIBE_TYPE, IamAction.CFN_LIST_TYPES],
        Resource: "*",
      },
      {
        Sid: "ResourceDiscoveryRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.SSM_GET_PARAMETER,
          IamAction.EC2_DESCRIBE_INSTANCES,
          IamAction.EC2_DESCRIBE_SUBNETS,
          IamAction.EC2_DESCRIBE_SECURITY_GROUPS,
          IamAction.EC2_DESCRIBE_KEY_PAIRS,
          IamAction.EC2_DESCRIBE_INSTANCE_TYPES,
          IamAction.EC2_DESCRIBE_IMAGES,
          IamAction.RDS_DESCRIBE_DB_ENGINE_VERSIONS,
          IamAction.RDS_DESCRIBE_ORDERABLE_INSTANCES,
        ],
        Resource: "*",
      },
      {
        Sid: "PricingRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.PRICING_GET_PRODUCTS,
          IamAction.PRICING_DESCRIBE_SERVICES,
          IamAction.PRICING_GET_ATTRIBUTE_VALUES,
        ],
        Resource: "*",
      },
      {
        Sid: "CostExplorerRead",
        Effect: IamEffect.ALLOW,
        Action: [
          IamAction.CE_GET_COST_AND_USAGE,
          IamAction.CE_GET_COST_FORECAST,
        ],
        Resource: "*",
      },
    ],
  };
}
