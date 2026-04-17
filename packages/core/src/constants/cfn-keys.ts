/** CloudFormation property keys used in plan-generator unwrapping logic. */

export const CloudFormationKey = {
  TYPE: "Type",
  PROPERTIES: "Properties",
} as const;

/** Prefix shared by all AWS CloudFormation resource type strings. */
export const CFN_RESOURCE_TYPE_PREFIX = "AWS::" as const;
