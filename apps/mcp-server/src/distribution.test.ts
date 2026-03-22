import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mcpRoot = resolve(__dirname, "..");

describe("Distribution package configuration", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(mcpRoot, "package.json"), "utf-8"),
  );

  it("has npm package name '@assignee/mcp-server'", () => {
    expect(pkg.name).toBe("@assignee/mcp-server");
  });

  it("is marked as private until approved for publishing", () => {
    expect(pkg.private).toBe(true);
  });

  it("has bin field pointing to dist/index.js", () => {
    expect(pkg.bin).toEqual({ "assignee-mcp-server": "./dist/index.js" });
  });

  it("has files array with dist, README.md, LICENSE", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");
  });

  it("does not include source files or test files in files array", () => {
    for (const entry of pkg.files) {
      expect(entry).not.toMatch(/src/);
      expect(entry).not.toMatch(/test/);
      expect(entry).not.toMatch(/vitest/);
    }
  });

  it("has engines.node >= 20", () => {
    expect(pkg.engines).toBeDefined();
    expect(pkg.engines.node).toBe(">=20.0.0");
  });

  it("has repository field", () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.repository.type).toBe("git");
    expect(pkg.repository.directory).toBe("apps/mcp-server");
  });

  it("has keywords array with mcp-related terms", () => {
    expect(pkg.keywords).toBeInstanceOf(Array);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain("assignee");
    expect(pkg.keywords).toContain("mcp");
    expect(pkg.keywords).toContain("mcp-server");
    expect(pkg.keywords).toContain("model-context-protocol");
  });

  it("has prepublishOnly script that runs turbo build", () => {
    expect(pkg.scripts.prepublishOnly).toBeDefined();
    expect(pkg.scripts.prepublishOnly).toContain("turbo build");
  });

  it("has description", () => {
    expect(pkg.description).toBeDefined();
    expect(pkg.description.length).toBeGreaterThan(10);
  });

  it("has license field", () => {
    expect(pkg.license).toBe("MIT");
  });

  it("has homepage field", () => {
    expect(pkg.homepage).toBe("https://assignee.ai");
  });

  it("dist/index.js has shebang line", () => {
    const indexPath = resolve(mcpRoot, "dist", "index.js");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });

  it("README.md exists", () => {
    const readmePath = resolve(mcpRoot, "README.md");
    expect(existsSync(readmePath)).toBe(true);
  });

  it("README.md contains agent configuration examples", () => {
    const readmePath = resolve(mcpRoot, "README.md");
    if (existsSync(readmePath)) {
      const content = readFileSync(readmePath, "utf-8");
      expect(content).toContain("Claude Code");
      expect(content).toContain("Cursor");
      expect(content).toContain("Windsurf");
      expect(content).toContain("npx @assignee/mcp-server");
    }
  });
});
