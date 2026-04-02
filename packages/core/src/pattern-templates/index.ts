import { PatternRegistry } from "./registry.js";
import { serverlessApiPattern } from "./patterns/serverless-api.js";
import { threeTierWebPattern } from "./patterns/three-tier-web.js";
import { containerServicePattern } from "./patterns/container-service.js";
import { messageProcessingPattern } from "./patterns/message-processing.js";
import { staticWebsitePattern } from "./patterns/static-website.js";

/**
 * Default pre-populated pattern registry.
 * Import this in intent-parser.ts — do not instantiate PatternRegistry elsewhere.
 *
 * To add a new pattern:
 *   1. Create patterns/<pattern-name>.ts
 *   2. Import + register here
 *   Zero changes to graph nodes or CLI commands required.
 */
export const defaultPatternRegistry = new PatternRegistry();
defaultPatternRegistry.register(serverlessApiPattern);
defaultPatternRegistry.register(threeTierWebPattern);
defaultPatternRegistry.register(containerServicePattern);
defaultPatternRegistry.register(messageProcessingPattern);
defaultPatternRegistry.register(staticWebsitePattern);

export { PatternRegistry };
export { serverlessApiPattern } from "./patterns/serverless-api.js";
export { threeTierWebPattern } from "./patterns/three-tier-web.js";
export { containerServicePattern } from "./patterns/container-service.js";
export { messageProcessingPattern } from "./patterns/message-processing.js";
export { staticWebsitePattern } from "./patterns/static-website.js";
export type { ArchitecturePattern, ResourceSpec } from "./types.js";
export {
  ServerlessApiResourceId,
  MessageProcessingResourceId,
  ThreeTierWebResourceId,
  ContainerServiceResourceId,
  StaticWebsiteResourceId,
} from "./pattern-resource-ids.js";
