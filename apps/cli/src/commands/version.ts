/**
 * `assignee version` command — richer version + environment info.
 *
 * Distinct from the built-in `--version` flag: this subcommand also prints
 * Node.js version, platform/arch, and the pinned MCP server versions.
 * Those MCP pins matter for bug reports because each server carries its
 * own feature set — an issue against the pricing or documentation server
 * is much easier to triage with the exact version stamp.
 *
 * Registered via `program.addCommand(versionCommand)` so it participates
 * in the shared Commander tree walked by `scripts/generate-completions.ts`
 * and by `completions.ts`. Previously the command was inlined in
 * `src/index.ts` and the completion-generator had to re-declare a stub
 * copy; exposing it as a standalone module closes that drift gap
 * (Epic 58-it1-03, closes `it57-1-L3-L1`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

/**
 * Resolve the CLI version from `apps/cli/package.json`.
 *
 * Matches the lookup used by the root `program.version(pkg.version)` call
 * in `src/index.ts`, so `assignee --version` and `assignee version` can
 * never drift apart.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const versionCommand = new Command("version")
  .description("Show version and environment info")
  .action(async () => {
    const { MCP_PINS } = await import("../config/mcp-servers.js");
    const lines = [
      `assignee ${readPackageVersion()}`,
      `node     ${process.version}`,
      `platform ${process.platform} ${process.arch}`,
      "",
      "Pinned MCP servers:",
      `  pricing        ${MCP_PINS.AWS_PRICING}`,
      `  documentation  ${MCP_PINS.AWS_DOCUMENTATION}`,
      `  iam            ${MCP_PINS.AWS_IAM}`,
      `  wa-security    ${MCP_PINS.AWS_WA_SECURITY}`,
      `  cost-mgmt      ${MCP_PINS.AWS_COST_MANAGEMENT}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  });
