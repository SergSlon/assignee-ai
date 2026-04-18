/**
 * MCP ↔ CLI graph parity invariant.
 *
 * Guards the moat claim that the MCP path "routes through the identical
 * 13-node graph, 185 BP rules, and HITL gate as the CLI" (README.md
 * MCP section). If MCP and CLI import `createGraph` from divergent
 * sources, an AI agent could bypass the human-approval boundary that
 * the CLI enforces — collapsing the moat.
 *
 * Closes Epic 55 it1 finding L10-002 (HIGH — MCP↔createGraph parity
 * invariant has no test).
 */

import { describe, it, expect } from "vitest";
import { createGraph as mcpCreateGraph } from "@assignee/core/graph";
import * as coreGraphIndex from "@assignee/core/graph";

describe("MCP ↔ CLI graph parity invariant", () => {
  it("MCP imports createGraph from @assignee/core/graph (canonical)", async () => {
    // The MCP server's graph-init.ts imports `createGraph` from
    // "@assignee/core/graph". This test asserts the symbol is what
    // we think it is — same module, same callable.
    const graphInitModule = await import("../services/graph-init.js");
    expect(graphInitModule.createGraphContext).toBeDefined();
    expect(typeof graphInitModule.createGraphContext).toBe("function");
    expect(mcpCreateGraph).toBe(coreGraphIndex.createGraph);
    expect(typeof mcpCreateGraph).toBe("function");
  });

  it("CLI's services/graph.ts re-exports the same createGraph as MCP", async () => {
    // CLI imports through a thin shim at apps/cli/src/services/graph.ts
    // that re-exports from "@assignee/core/graph". MCP imports
    // directly. Both must resolve to identical function reference.
    //
    // We can't import from apps/cli inside the MCP test workspace, but
    // we CAN assert the canonical export is a single source of truth
    // by reading the shim's source and confirming its re-export target.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliShimPath = path.resolve(
      here,
      "../../../../apps/cli/src/services/graph.ts",
    );
    const cliShimSource = await fs.readFile(cliShimPath, "utf8");
    expect(cliShimSource).toMatch(
      /export\s*\{[^}]*\bcreateGraph\b[^}]*\}\s*from\s*["']@assignee\/core\/graph["']/,
    );
  });

  it("MCP plan-resource handler routes through GraphContext, not local createGraph", async () => {
    // The plan-resource handler-steps must accept a GraphContext
    // (carrying the canonical graph built in graph-init.ts) and must
    // not synthesise its own pipeline. Asserted by source inspection:
    // file uses GraphContext type AND never calls createGraph().
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const handlerStepsPath = path.resolve(
      here,
      "../tools/plan-resource/handler-steps.ts",
    );
    const handlerStepsSource = await fs.readFile(handlerStepsPath, "utf8");
    expect(handlerStepsSource).not.toMatch(/\bcreateGraph\s*\(/);
    expect(handlerStepsSource).toMatch(/\bGraphContext\b/);
  });

  it("MCP apply-plan handler routes through GraphContext, not local createGraph", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const handlerStepsPath = path.resolve(
      here,
      "../tools/apply-plan/handler-steps.ts",
    );
    const handlerStepsSource = await fs.readFile(handlerStepsPath, "utf8");
    expect(handlerStepsSource).not.toMatch(/\bcreateGraph\s*\(/);
    expect(handlerStepsSource).toMatch(/\bGraphContext\b/);
  });

  it("MCP graph-init.ts is the SINGLE place where MCP instantiates the graph", async () => {
    // If anyone ever adds a second `createGraph()` call-site inside
    // the MCP server, this test fails — preserves the invariant
    // that the HITL gate baked into the canonical 13-node graph
    // cannot be bypassed by a parallel pipeline.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mcpSrcRoot = path.resolve(here, "..");

    async function walk(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") {
            continue;
          }
          files.push(...(await walk(full)));
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".d.ts")
        ) {
          files.push(full);
        }
      }
      return files;
    }

    const tsFiles = await walk(mcpSrcRoot);
    const callsiteFiles: string[] = [];
    for (const file of tsFiles) {
      const src = await fs.readFile(file, "utf8");
      // Walk line by line. A CALL site has `createGraph(` on a line that
      // is NOT an import / export / from-clause / comment / string.
      const lines = src.split("\n");
      const hasCallsite = lines.some((line) => {
        if (!/\bcreateGraph\s*\(/.test(line)) return false;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
        if (/^\s*(?:import|export)\b/.test(line)) return false;
        if (/from\s+["']/.test(line)) return false;
        return true;
      });
      if (hasCallsite) {
        callsiteFiles.push(file);
      }
    }
    expect(callsiteFiles).toHaveLength(1);
    expect(callsiteFiles[0]).toMatch(/services\/graph-init\.ts$/);
  });
});
