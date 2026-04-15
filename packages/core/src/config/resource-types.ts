/**
 * AWS CloudFormation resource type constants for the POC phase.
 * Single source of truth — used by intent_parser, schema_fetcher, resource_provisioner,
 * preflight_guard, and (in MVP) the policy validation engine.
 *
 * This file is now a pure barrel re-export. Implementation lives under
 * `./resource-types/` split by concern:
 *   - `supported.ts` — SUPPORTED_TYPES_ARRAY + ResourceType + SUPPORTED_POC_TYPES
 *   - `named.ts`     — RESOURCE_TYPES mapping of named constants
 *   - `fallback.ts`  — CCAPI fallback / redirect / SDK-routable tables
 *   - `companion.ts` — companion + listing-only resource types
 *
 * @see project-context.md — No Magic Strings section
 */

export * from "./resource-types/index.js";
