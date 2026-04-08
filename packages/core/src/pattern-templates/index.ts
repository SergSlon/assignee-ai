import { PatternRegistry } from "./registry.js";
import { serverlessApiPattern } from "./patterns/serverless-api.js";
import { threeTierWebPattern } from "./patterns/three-tier-web.js";
import { containerServicePattern } from "./patterns/container-service.js";
import { messageProcessingPattern } from "./patterns/message-processing.js";
import { staticWebsitePattern } from "./patterns/static-website.js";
import {
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
} from "./patterns/vpc-networking.js";
import { lambdaWithExecRolePattern } from "./patterns/lambda-with-exec-role.js";
import { efsWithVpcPattern } from "./patterns/efs-with-vpc.js";

export { PatternId } from "./pattern-ids.js";

/**
 * Default pre-populated pattern registry.
 * Import this in intent-parser.ts — do not instantiate PatternRegistry elsewhere.
 *
 * To add a new pattern:
 *   1. Create patterns/<pattern-name>.ts
 *   2. Import + register here
 *   Zero changes to graph nodes or CLI commands required.
 *
 * **Registration order matters.** PatternRegistry.detect() returns the
 * FIRST keyword match in insertion order. Larger / more specific
 * patterns must register BEFORE smaller / more generic ones so
 * intents like "create a serverless api with lambda" match the
 * 8-resource serverless-api pattern instead of the 2-resource
 * lambda-with-exec-role pattern. The lambda-with-exec-role pattern is
 * therefore registered LAST among the Lambda-bearing patterns.
 */
export const defaultPatternRegistry = new PatternRegistry();
defaultPatternRegistry.register(serverlessApiPattern);
defaultPatternRegistry.register(threeTierWebPattern);
defaultPatternRegistry.register(containerServicePattern);
defaultPatternRegistry.register(messageProcessingPattern);
defaultPatternRegistry.register(staticWebsitePattern);
// EFS-with-VPC must register BEFORE vpc-networking — the "efs" keyword
// family is more specific than the generic "vpc" keywords, but both
// patterns produce VPC resources, so first-match-wins order matters.
defaultPatternRegistry.register(efsWithVpcPattern);
defaultPatternRegistry.register(vpcNetworkingPattern);
defaultPatternRegistry.register(vpcPublicOnlyPattern);
// Wave 13: registered LAST so longer-form Lambda-bearing intents match
// their dedicated patterns first. See pattern file for the keyword
// disjointness analysis.
defaultPatternRegistry.register(lambdaWithExecRolePattern);

export { PatternRegistry };
export { serverlessApiPattern } from "./patterns/serverless-api.js";
export { threeTierWebPattern } from "./patterns/three-tier-web.js";
export { containerServicePattern } from "./patterns/container-service.js";
export { messageProcessingPattern } from "./patterns/message-processing.js";
export { staticWebsitePattern } from "./patterns/static-website.js";
export {
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
} from "./patterns/vpc-networking.js";
export { lambdaWithExecRolePattern } from "./patterns/lambda-with-exec-role.js";
export { efsWithVpcPattern } from "./patterns/efs-with-vpc.js";
export type { ArchitecturePattern, ResourceSpec } from "./types.js";
export {
  ServerlessApiResourceId,
  MessageProcessingResourceId,
  ThreeTierWebResourceId,
  ContainerServiceResourceId,
  StaticWebsiteResourceId,
  LambdaWithExecRoleResourceId,
  EfsWithVpcResourceId,
} from "./pattern-resource-ids.js";
