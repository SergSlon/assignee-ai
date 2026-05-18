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

  it("is publish-ready: private:false + publishConfig.access=public + provenance", () => {
    // RR-1 of RELEASE_CHECKLIST.md flipped 2026-05-18 (PR closing RR-1).
    // The previous guardrail ("private until approved for publishing") fired
    // on every test run to signal "don't accidentally publish"; once the
    // user explicitly authorized publish, the test inverted to assert the
    // new publish-ready shape so a future accidental revert (private:true
    // or missing publishConfig) fails loudly.
    expect(pkg.private).toBe(false);
    expect(pkg.publishConfig).toEqual({
      access: "public",
      provenance: true,
    });
  });

  it("has bin field pointing to dist/index.js", () => {
    expect(pkg.bin).toEqual({ assignee: "./dist/index.js" });
  });

  it("has files array with dist globs, completions, README.md, LICENSE", () => {
    expect(pkg.files).toContain("dist/**/*.js");
    expect(pkg.files).toContain("dist/**/*.d.ts");
    expect(pkg.files).toContain("dist/**/*.d.ts.map");
    expect(pkg.files).toContain("completions");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");
  });

  it("excludes test files and test-fixtures from files array", () => {
    expect(pkg.files).toContain("!dist/**/*.test.*");
    expect(pkg.files).toContain("!dist/**/test-fixtures/**");
    for (const entry of pkg.files) {
      expect(entry).not.toMatch(/src/);
      expect(entry).not.toMatch(/vitest/);
    }
  });

  it("has engines.node >= 20.11", () => {
    // Tier C: dropped redundant toBeDefined() — .node access fails on undefined
    expect(pkg.engines.node).toBe(">=20.11");
  });

  it("has repository field", () => {
    // Tier C: dropped redundant toBeDefined()
    expect(pkg.repository.type).toBe("git");
  });

  it("has keywords array", () => {
    expect(pkg.keywords).toBeInstanceOf(Array);
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain("assignee");
    expect(pkg.keywords).toContain("cli");
  });

  it("has prepublishOnly script that runs turbo build", () => {
    // Tier C: dropped redundant toBeDefined() — toContain fails on undefined
    expect(pkg.scripts.prepublishOnly).toContain("turbo build");
  });

  it("has description with at least 10 chars", () => {
    // Tier C: dropped redundant toBeDefined() — typeof string is stronger
    expect(typeof pkg.description).toBe("string");
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
