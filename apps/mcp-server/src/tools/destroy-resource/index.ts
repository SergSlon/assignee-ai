/**
 * Barrel for destroy-resource sub-modules.
 * The MCP tool entrypoint (`../destroy-resource.ts`) composes these.
 */

export * from "./types.js";
export * from "./error-envelope.js";
export * from "./resolve.js";
export * from "./sts-cache.js";
export * from "./dispatcher.js";
export * from "./credentials.js";
export * from "./audit.js";
export * from "./handler-steps.js";
