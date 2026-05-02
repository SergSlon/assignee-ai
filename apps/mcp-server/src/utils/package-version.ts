/**
 * W24b-S4: Runtime version reader for the MCP server.
 *
 * Reads `version` from the package's own package.json at module load so
 * the McpServer constructor always receives the single source of truth.
 * Using a file-system read avoids any hardcoded literal that can drift when
 * package.json is bumped independently of TypeScript sources.
 *
 * At runtime (dist/utils/package-version.js) `import.meta.url` points to
 * `<pkgRoot>/dist/utils/package-version.js`, so `../..` reaches the
 * package root where package.json lives.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const _dir = dirname(fileURLToPath(import.meta.url));
// dist/utils/ → dist/ → package root
const _pkgPath = resolve(_dir, "..", "..", "package.json");
const _pkg = JSON.parse(readFileSync(_pkgPath, "utf-8")) as {
  version: string;
};

/**
 * The version string from this package's package.json.
 * Evaluated once at module load; effectively a read-only constant at runtime.
 */
export const MCP_SERVER_VERSION: string = _pkg.version;

/**
 * Returns the package.json version string.
 * Provided as a named function to aid testability (import without side-effects).
 */
export function readMcpServerVersion(): string {
  return MCP_SERVER_VERSION;
}
