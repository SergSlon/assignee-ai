import { RESOURCE_TYPES } from "@/config/resource-types.js";
import type { ResourcePlugin } from "../../types.js";
import { commonFields, advancedFields } from "./fields.js";
import { defaults, companionResources, configHints } from "./config.js";

export { commonFields, advancedFields, defaults, configHints };

/** ResourcePlugin for AWS::RDS::DBInstance. */
export const rdsDbInstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
  commonFields,
  advancedFields,
  defaults,
  companionResources,
  configHints,
};
