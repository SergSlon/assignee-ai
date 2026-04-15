/**
 * Per-resource-type label overrides for ambiguous CFN property names
 * plus the label resolver that consults the override map first.
 *
 * FRIENDLY_NAMES is keyed by raw CFN property name (e.g., "Type"), and
 * many resources share the same property name with different semantics:
 *   - AWS::ElasticLoadBalancingV2::LoadBalancer.Type = application | network
 *   - AWS::ElasticLoadBalancingV2::TargetGroup.TargetType = instance | ip | lambda
 *   - AWS::SSM::Parameter.Type = String | StringList | SecureString
 *   - AWS::DynamoDB::Table.KeySchema[].KeyType = HASH | RANGE
 *
 * When a resource-type-scoped label exists, it wins over the global
 * FRIENDLY_NAMES lookup.
 */
import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import { FRIENDLY_NAMES } from "./friendly-names.js";

export const FRIENDLY_NAMES_BY_TYPE: Record<string, Record<string, string>> = {
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: {
    [CfnKey.TYPE]: "Load Balancer Type",
  },
  [RESOURCE_TYPES.SSM_PARAMETER]: {
    // CfnKey.SSM_TYPE === CfnKey.TYPE === "Type" but we use the SSM-specific
    // constant here to document intent at the call site.
    [CfnKey.SSM_TYPE]: "Parameter Type",
    [CfnKey.SSM_VALUE]: "Parameter Value",
  },
  [RESOURCE_TYPES.DYNAMODB_TABLE]: {
    // DynamoDB tables don't have a top-level "Type" field but may surface one
    // via free-form desiredState — make sure we never accidentally label it as
    // "Load Balancer Type".
    [CfnKey.TYPE]: "Type",
  },
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: {
    [CfnKey.TYPE]: "Alarm Type",
  },
};

/**
 * Converts a PascalCase key to a spaced name (fallback for unknown keys).
 * E.g., "IamInstanceProfile" -> "Iam Instance Profile"
 */
export function spacePascalCase(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Resolves the display label for a CFN property key, respecting the
 * per-resource-type override map when a resource type is supplied.
 *
 * Lookup order:
 *   1. FRIENDLY_NAMES_BY_TYPE[resourceType][key] (per-resource override)
 *   2. FRIENDLY_NAMES[key] (unambiguous global label)
 *   3. spacePascalCase(key) (fallback — "FooBar" → "Foo Bar")
 */
export function resolveFieldLabel(key: string, resourceType?: string): string {
  if (resourceType) {
    const scoped = FRIENDLY_NAMES_BY_TYPE[resourceType]?.[key];
    if (scoped) return scoped;
  }
  return FRIENDLY_NAMES[key] ?? spacePascalCase(key);
}
