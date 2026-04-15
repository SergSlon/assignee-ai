/**
 * Re-export barrel for the resource-resolver pipeline.
 *
 * Split into `./resource-resolver/` during Wave 6e F3 to enforce the
 * 300-LOC/file rule. External callers and tests continue to import
 * from `../services/resource-resolver.js`.
 *
 * ARN helpers (`isArn`, `arnToResourceType`, `extractIdentifierFromArn`,
 * `extractRegionFromArn`, `getCloudControlIdentifier`) live in
 * `packages/core/src/config/arn-helpers.ts` (Wave 4 F8).
 *
 * @see ./resource-resolver/index.ts
 * @see Story 18.5
 */

export type {
  AmbiguousResolution,
  Resolution,
  ResolvedResource,
} from "./resource-resolver/index.js";
export {
  createTaggingClient,
  isAmbiguousResolution,
  resolveResource,
} from "./resource-resolver/index.js";
