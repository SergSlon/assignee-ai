/**
 * Public barrel for the resource-resolver pipeline.
 *
 * @see Story 18.5
 */

export type { ResolvedResource } from "./types.js";
export { createTaggingClient } from "./client-factory.js";
export { resolveResource } from "./disambiguator.js";
