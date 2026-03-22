import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliRoot = resolve(__dirname, "..");

describe("Distribution package configuration", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(cliRoot, "package.json"), "utf-8"),
  );

  it("has npm package name 'assignee'", () => {
    expect(pkg.name).toBe("assignee");
  });

  it("is not marked as private", () => {
    expect(pkg.private).toBeUndefined();
  });

  it("has bin field pointing to dist/index.js", () => {
    expect(pkg.bin).toEqual({ assignee: "./dist/index.js" });
  });

  it("has files array with dist, completions, README.md, LICENSE", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("completions");
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
  });

  it("has keywords array", () => {
    expect(pkg.keywords).toBeInstanceOf(Array);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain("assignee");
    expect(pkg.keywords).toContain("cli");
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

  it("dist/index.js has shebang line", () => {
    const indexPath = resolve(cliRoot, "dist", "index.js");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    }
  });

  it("completions directory exists with shell scripts", () => {
    const completionsDir = resolve(cliRoot, "completions");
    expect(existsSync(completionsDir)).toBe(true);
    expect(existsSync(resolve(completionsDir, "assignee.bash"))).toBe(true);
    expect(existsSync(resolve(completionsDir, "assignee.zsh"))).toBe(true);
    expect(existsSync(resolve(completionsDir, "assignee.fish"))).toBe(true);
  });
});
