/**
 * Flag-registration smoke tests for the `optimize` command.
 *
 * Epic 92 / story e92-3b2 (D-03): the local `--no-color` option that
 * used to live on `optimize` was removed because it shadowed the
 * global `--no-color` declared on the root program in
 * `apps/cli/src/index.ts`. This test pins the invariant so a future
 * regression cannot silently reintroduce the local flag.
 */
import { describe, it, expect } from "vitest";
import { optimizeCommand } from "./optimize.js";

describe("optimize command — e92-3b2 flag-registration invariants", () => {
  it("does not register a local --no-color option (served by global)", () => {
    const localNoColor = optimizeCommand.options.find(
      (o) => o.long === "--no-color",
    );
    expect(localNoColor).toBeUndefined();
  });

  it("still registers --region, --json, and --min-savings", () => {
    const region = optimizeCommand.options.find((o) => o.long === "--region");
    const json = optimizeCommand.options.find((o) => o.long === "--json");
    const minSavings = optimizeCommand.options.find(
      (o) => o.long === "--min-savings",
    );
    expect(region).toBeDefined();
    expect(json).toBeDefined();
    expect(minSavings).toBeDefined();
  });

  it("declares command name as 'optimize'", () => {
    expect(optimizeCommand.name()).toBe("optimize");
  });
});
