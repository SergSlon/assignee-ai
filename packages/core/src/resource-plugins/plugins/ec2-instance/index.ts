import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import type { ResourcePlugin } from "../../types.js";
import { commonFields, advancedFields } from "./fields.js";
import { defaults, companionResources, configHints } from "./config.js";

// Story 46.4 (2026-04-12): the INSTANCE_CATEGORIES constant lives in its
// own module at `../../instance-type-registry.ts`. Re-exported here for
// any external consumer that imports it from the plugin module directly.
export { INSTANCE_CATEGORIES } from "../../instance-type-registry.js";
export { classifyUserData, encodeUserData } from "./user-data.js";
export { commonFields, advancedFields, defaults, configHints };

export const ec2InstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INSTANCE,
  commonFields,
  advancedFields,
  defaults,
  companionResources,
  configHints,
};
