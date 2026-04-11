#!/usr/bin/env npx tsx
/**
 * MCP version drift CI gate.
 *
 * Walks every entry in `MCP_PINS`, fetches the latest stable version from
 * PyPI, and exits non-zero if any pinned MCP server is behind upstream.
 * Run by `pnpm check-mcp-versions` (root scripts) and intended for CI gates
 * that should fail when an MCP release goes unnoticed.
 *
 * The implementation lives in `src/services/mcp-version-check.ts` so that
 * the strict-tsconfig `src/**` compile boundary can both type-check it AND
 * unit-test it. This file is a 5-line entry-point wrapper.
 *
 * Exit codes:
 *   0 — every pin is up-to-date OR every fetch failed (offline runner)
 *   1 — at least one pin is behind upstream
 *
 * @see Story 45.6 — MCP version drift monitoring
 */

import { runMcpVersionScript } from "../src/services/mcp-version-check.js";

runMcpVersionScript()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
