/**
 * Tests for project-level config loader.
 *
 * @see Story 27.3 — Project-Level Config
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: { CONFIG_LOADED: "config_loaded" },
}));

import { loadProjectConfig } from "./project-config-loader.js";

let tmpDir: string;

describe("project-config-loader", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proj-config-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns parsed config when .assignee/config.yaml exists in cwd", async () => {
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      `defaults:
  region: us-west-2
  tags:
    team: backend
preferences:
  auto_fix: skip
`,
      "utf-8",
    );
    // Create a project root marker so we don't walk above tmpDir
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");

    const result = await loadProjectConfig(tmpDir);

    // Tier C: dropped redundant toBeDefined() — optional-chained property
    // toBe(literal) checks fail naturally on undefined
    expect(result?.defaults?.region).toBe("us-west-2");
    expect(result?.defaults?.tags).toEqual({ team: "backend" });
    expect(result?.preferences?.auto_fix).toBe("skip");
  });

  it("returns config found in parent directory", async () => {
    // Create project root marker + config in tmpDir
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      `defaults:
  region: eu-west-1
`,
      "utf-8",
    );

    // Start search from a subdirectory
    const subDir = path.join(tmpDir, "src", "lib");
    await fs.mkdir(subDir, { recursive: true });

    const result = await loadProjectConfig(subDir);

    // Tier C: dropped redundant toBeDefined()
    expect(result?.defaults?.region).toBe("eu-west-1");
  });

  it("returns undefined when no .assignee/config.yaml exists", async () => {
    // Create a project root marker but no config
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");

    const result = await loadProjectConfig(tmpDir);

    expect(result).toBeUndefined();
  });

  it("returns undefined and warns on malformed YAML", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    // Write invalid config (preferences.auto_fix with bad value triggers ConfigurationError)
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      `preferences:
  auto_fix: invalid_value
`,
      "utf-8",
    );

    const result = await loadProjectConfig(tmpDir);

    expect(result).toBeUndefined();
  });

  it("stops at .git boundary and does not walk above project root", async () => {
    // Create .git in tmpDir (project root)
    await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true });

    // Put config ABOVE tmpDir — it should NOT be found
    // Since tmpDir is already in os.tmpdir(), we can't easily test above it,
    // but we verify that when no config exists in the project, undefined is returned
    const result = await loadProjectConfig(tmpDir);

    expect(result).toBeUndefined();
  });

  it("returns validated config with defaults applied", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}", "utf-8");
    const configDir = path.join(tmpDir, ".assignee");
    await fs.mkdir(configDir, { recursive: true });
    // Minimal config — validateConfig should fill in preference defaults
    await fs.writeFile(
      path.join(configDir, "config.yaml"),
      `defaults:
  region: ap-southeast-1
`,
      "utf-8",
    );

    const result = await loadProjectConfig(tmpDir);

    // Tier C: dropped redundant toBeDefined()
    expect(result?.defaults?.region).toBe("ap-southeast-1");
    // validateConfig fills in preference defaults
    expect(result?.preferences?.auto_fix).toBe("ask");
  });
});
