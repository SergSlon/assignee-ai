/**
 * Best Practices MCP Enricher — public entry point.
 *
 * Decomposed into `./bp-mcp-enricher/` per-concern modules (Wave 6e F1).
 * Kept here as a barrel so existing importers
 * (`./advice/bp-mcp-enricher.js`) continue to resolve unchanged.
 */
export { enrichBpWithMcp } from "./bp-mcp-enricher/orchestrator.js";
