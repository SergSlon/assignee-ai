/**
 * ALB layer for the three-tier-web pattern.
 *
 * Split from three-tier-web.ts (W6d F3). Internet-facing Application
 * Load Balancer placed across both public subnets.
 */

import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import { AwsDefault } from "../../../config/cfn-keys.js";
import { markerRef } from "../../../config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";
import { ThreeTierWebResourceId as R } from "../../pattern-resource-ids.js";

export const albLayerResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    resourceId: R.ALB,
    displayName: "Application Load Balancer",
  },
];

export const albLayerDefaults = {
  [R.ALB]: {
    Type: AwsDefault.LB_TYPE_APPLICATION,
    Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
    Subnets: [markerRef(R.PUBLIC_SUBNET_1), markerRef(R.PUBLIC_SUBNET_2)],
    SecurityGroups: [markerRef(R.ALB_SG)],
  },
} as const;
