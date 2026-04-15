/**
 * Cost alternative advisor — public entry point.
 *
 * Decomposed into `./cost-advisor/` per-resource concerns (Wave 6e F1).
 * Kept here as a barrel so existing importers
 * (`./advice/cost-advisor.js`) continue to resolve unchanged.
 */
export { costAlternatives } from "./cost-advisor/orchestrator.js";
