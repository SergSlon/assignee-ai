import { PluginRegistry } from "./registry.js";
import { s3BucketPlugin } from "./plugins/s3-bucket.js";
import { ec2InstancePlugin } from "./plugins/ec2-instance.js";
import { rdsDbInstancePlugin } from "./plugins/rds-dbinstance.js";
import { lambdaFunctionPlugin } from "./plugins/lambda-function.js";
import { genericPlugin } from "./plugins/generic.js";

/**
 * The default pre-populated plugin registry for Assignee.ai.
 * Import this in graph nodes and CLI commands — do not instantiate a new PluginRegistry elsewhere.
 *
 * To add a new plugin:
 *   1. Create `plugins/<resource-name>.ts`
 *   2. Import it here and call `defaultPluginRegistry.register(yourPlugin)`
 *   Zero changes to graph nodes or CLI command files are required.
 */
export const defaultPluginRegistry = new PluginRegistry();
defaultPluginRegistry.register(s3BucketPlugin);
defaultPluginRegistry.register(ec2InstancePlugin);
defaultPluginRegistry.register(rdsDbInstancePlugin);
defaultPluginRegistry.register(lambdaFunctionPlugin);
defaultPluginRegistry.register(genericPlugin);

export { PluginRegistry };
export { s3BucketPlugin } from "./plugins/s3-bucket.js";
export { ec2InstancePlugin } from "./plugins/ec2-instance.js";
export { rdsDbInstancePlugin } from "./plugins/rds-dbinstance.js";
export { lambdaFunctionPlugin } from "./plugins/lambda-function.js";
export { genericPlugin } from "./plugins/generic.js";
export type {
  ResourcePlugin,
  ResourceField,
  FieldQuestion,
  FetcherContext,
  QuestionType,
  ShowIfCondition,
} from "./types.js";
