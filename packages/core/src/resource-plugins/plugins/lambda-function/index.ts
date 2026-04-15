import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import type { ResourcePlugin } from "../../types.js";
import { commonFields, advancedFields } from "./fields.js";
import { defaults, companionResources, configHints } from "./config.js";

export {
  LAMBDA_USD_PER_GB_SECOND,
  sortedRuntimes,
  runtimeOptions,
  memoryLabel,
  buildRuntimeHint,
  sortedRuntimeOptions,
} from "./runtimes.js";
export type { RuntimeOption } from "./runtimes.js";
export {
  LAMBDA_RESERVED_PREFIXES,
  LAMBDA_RESERVED_EXACT,
  checkLambdaEnvVarKey,
  validateEnvironmentField,
  environmentToCfn,
} from "./env-vars.js";
export { commonFields, advancedFields, defaults, configHints };

/** ResourcePlugin for AWS::Lambda::Function. */
export const lambdaFunctionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
  commonFields,
  advancedFields,
  defaults,
  configHints,
  companionResources,
};
