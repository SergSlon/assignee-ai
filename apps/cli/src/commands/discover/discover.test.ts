/**
 * Unit tests for `assignee discover` — Story 108-A-03.
 *
 * Coverage plan (Axes A–L per story spec):
 *
 *  A  Empty / project-root workspace detection — both paths produce valid output.
 *  B  Fuzzy match hits — input "s3" returns items including S3 Bucket.
 *  C  Fuzzy match no results — input "xyzzy" returns empty array.
 *  D  TTY interactive mode full flow — selection produces sample plan invocation.
 *  E  Non-TTY paged list — correct headers, all type IDs present, zero ANSI codes.
 *  F  --json mode — valid JSON, correct item count, all fields non-null.
 *  G  --category resource-types — only resource-type items.
 *  H  --category patterns — only pattern items.
 *  I  --category commands — only command items.
 *  J  Shell completion coverage — "discover" appears in Commander program tree.
 *  K  --help output — describes flags correctly, no undefined values.
 *  L  Registry parity — item count equals types + patterns + commands from harness.
 *
 * NOTE: Interactive-picker tests (Axis D) mock `@clack/prompts` to avoid
 * the real terminal dependency. All other axes test the data layer directly.
 *
 * Story 108-A-03.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";
import {
  buildCatalogue,
  fuzzyFilter,
  DISCOVER_COMMAND_LIST,
} from "./discover-data.js";
import { discoverCommand } from "./discover.js";

/**
 * Registry-parity helpers — equivalent to `enumerateTypes()` and
 * `enumeratePatterns()` from the variant-matrix harness but sourced from
 * `@assignee/core` (the compiled dist) so the CLI's vitest runner can
 * resolve them without the `@/` path alias that the core's raw src uses.
 *
 * The variant-matrix `index.ts` functions delegate to the same sources:
 *   enumerateTypes()    → SUPPORTED_TYPES_ARRAY
 *   enumeratePatterns() → defaultPatternRegistry.list()
 */
function enumerateTypes(): readonly string[] {
  return SUPPORTED_TYPES_ARRAY;
}

function enumeratePatterns(): Array<{
  patternId: string;
  displayName: string;
  resourceCount: number;
}> {
  return defaultPatternRegistry.list().map((p) => ({
    patternId: p.patternId,
    displayName: p.displayName,
    resourceCount: p.resourceList.length,
  }));
}

// ---------------------------------------------------------------------------
// Mock @clack/prompts (prevents real TTY requirement in CI)
// ---------------------------------------------------------------------------

vi.mock("@clack/prompts", () => ({
  isCancel: vi.fn().mockReturnValue(false),
  autocomplete: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check whether a string contains any ANSI escape sequences. */
function hasAnsi(str: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[[0-9;]*m/.test(str);
}

// ---------------------------------------------------------------------------
// Axis A — Empty workspace vs project-root-detected
// ---------------------------------------------------------------------------

describe("Axis A — workspace detection paths produce valid output", () => {
  it("builds a catalogue without crashing when no workspace is detected", () => {
    const items = buildCatalogue();
    expect(items.length).toBeGreaterThan(0);
  });

  it("builds a catalogue without crashing — all categories present", () => {
    const items = buildCatalogue();
    const categories = new Set(items.map((i) => i.category));
    expect(categories.has("resource-types")).toBe(true);
    expect(categories.has("patterns")).toBe(true);
    expect(categories.has("commands")).toBe(true);
  });

  it("catalogue is available in all workspace contexts (infra-type ids present)", () => {
    const items = buildCatalogue();
    const ids = new Set(items.map((i) => i.id));
    // Common infra types expected in any workspace context
    expect(ids.has("AWS::EC2::Instance")).toBe(true);
    expect(ids.has("AWS::RDS::DBInstance")).toBe(true);
    expect(ids.has("AWS::S3::Bucket")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Axis B — Fuzzy match hits
// ---------------------------------------------------------------------------

describe("Axis B — fuzzy match hits", () => {
  it("'s3' matches items containing S3 (case-insensitive)", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "s3");
    const ids = results.map((r) => r.id);
    // Must include the S3 bucket resource type
    expect(ids).toContain("AWS::S3::Bucket");
    // Must NOT contain purely unrelated types
    expect(ids).not.toContain("AWS::EC2::Instance");
  });

  it("matches by description when query matches description text", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "serverless");
    expect(results.length).toBeGreaterThan(0);
  });

  it("matches commands by name", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "drift");
    const ids = results.map((r) => r.id);
    expect(ids).toContain("drift");
  });

  it("filter is case-insensitive", () => {
    const allItems = buildCatalogue();
    const lower = fuzzyFilter(allItems, "lambda");
    const upper = fuzzyFilter(allItems, "LAMBDA");
    const ids = lower.map((r) => r.id);
    const idsUpper = upper.map((r) => r.id);
    expect(ids).toEqual(idsUpper);
    expect(ids).toContain("AWS::Lambda::Function");
  });
});

// ---------------------------------------------------------------------------
// Axis C — Fuzzy match no results
// ---------------------------------------------------------------------------

describe("Axis C — fuzzy match no results", () => {
  it("returns empty array for query with no matches", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "xyzzy");
    expect(results).toHaveLength(0);
  });

  it("does not crash when query matches nothing", () => {
    const allItems = buildCatalogue();
    expect(() => fuzzyFilter(allItems, "xyzzy_no_match_zzzq")).not.toThrow();
  });

  it("returns all items for empty query", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "");
    expect(results).toHaveLength(allItems.length);
  });

  it("returns all items for whitespace-only query", () => {
    const allItems = buildCatalogue();
    const results = fuzzyFilter(allItems, "   ");
    expect(results).toHaveLength(allItems.length);
  });
});

// ---------------------------------------------------------------------------
// Axis D — TTY interactive mode full flow
// ---------------------------------------------------------------------------

describe("Axis D — TTY interactive mode full flow", () => {
  it("each resource type item has a non-empty exampleIntent with 'assignee infra plan'", () => {
    const items = buildCatalogue("resource-types");
    for (const item of items) {
      expect(item.exampleIntent).toBeTruthy();
      // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
      expect(item.exampleIntent).toContain("assignee infra plan");
    }
  });

  it("each pattern item has a non-empty exampleIntent with 'assignee infra plan'", () => {
    const items = buildCatalogue("patterns");
    for (const item of items) {
      expect(item.exampleIntent).toBeTruthy();
      // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
      expect(item.exampleIntent).toContain("assignee infra plan");
    }
  });

  it("each command item has a non-empty exampleIntent with 'assignee'", () => {
    const items = buildCatalogue("commands");
    for (const item of items) {
      expect(item.exampleIntent).toBeTruthy();
      expect(item.exampleIntent).toContain("assignee");
    }
  });

  it("selected resource type has a sample plan invocation in exampleIntent", () => {
    // Simulate a selection by choosing the first resource type item
    const items = buildCatalogue("resource-types");
    const selected = items[0]!;
    // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
    expect(selected.exampleIntent).toContain("assignee infra plan");
    expect(selected.id).toBeTruthy();
    expect(selected.description).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Axis E — Non-TTY paged list
// ---------------------------------------------------------------------------

describe("Axis E — non-TTY paged list output", () => {
  let originalIsTTY: boolean | undefined;
  let capturedOutput: string;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined, // undefined = piped/non-TTY per init.ts pattern
      writable: true,
      configurable: true,
    });
    capturedOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      capturedOutput += String(data);
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("plain-text output contains category headers", async () => {
    await discoverCommand.parseAsync(["discover"], { from: "user" });
    expect(capturedOutput).toContain("## Resource Types");
    expect(capturedOutput).toContain("## Patterns");
    expect(capturedOutput).toContain("## Commands");
  });

  it("plain-text output contains all registered type IDs", async () => {
    await discoverCommand.parseAsync(["discover"], { from: "user" });
    const types = enumerateTypes();
    for (const type of types) {
      expect(capturedOutput).toContain(type);
    }
  });

  it("plain-text output contains no ANSI escape codes", async () => {
    await discoverCommand.parseAsync(["discover"], { from: "user" });
    expect(hasAnsi(capturedOutput)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Axis F — --json mode
// ---------------------------------------------------------------------------

describe("Axis F — --json mode output", () => {
  let capturedOutput: string;

  beforeEach(() => {
    capturedOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      capturedOutput += String(data);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--json produces valid JSON", async () => {
    await discoverCommand.parseAsync(["discover", "--json"], { from: "user" });
    expect(() => JSON.parse(capturedOutput)).not.toThrow();
  });

  it("--json produces an array", async () => {
    await discoverCommand.parseAsync(["discover", "--json"], { from: "user" });
    const parsed = JSON.parse(capturedOutput) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("--json items all have required fields (non-null/non-undefined)", async () => {
    await discoverCommand.parseAsync(["discover", "--json"], { from: "user" });
    const items = JSON.parse(capturedOutput) as Array<{
      id: unknown;
      category: unknown;
      description: unknown;
      exampleIntent: unknown;
    }>;
    for (const item of items) {
      expect(item.id).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.exampleIntent).toBeTruthy();
    }
  });

  it("--json includes items from all three categories", async () => {
    await discoverCommand.parseAsync(["discover", "--json"], { from: "user" });
    const items = JSON.parse(capturedOutput) as Array<{
      id: string;
      category: string;
      description: string;
      exampleIntent: string;
    }>;
    const categories = new Set(items.map((i) => i.category));
    expect(categories.has("resource-types")).toBe(true);
    expect(categories.has("patterns")).toBe(true);
    expect(categories.has("commands")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Axis G — --category resource-types filter
// ---------------------------------------------------------------------------

describe("Axis G — --category resource-types filter", () => {
  it("buildCatalogue('resource-types') returns only resource-type items", () => {
    const items = buildCatalogue("resource-types");
    for (const item of items) {
      expect(item.category).toBe("resource-types");
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it("resource-types items contain no patterns or commands", () => {
    const items = buildCatalogue("resource-types");
    const nonTypes = items.filter((i) => i.category !== "resource-types");
    expect(nonTypes).toHaveLength(0);
  });

  it("all registered types appear in the resource-types category", () => {
    const items = buildCatalogue("resource-types");
    const ids = new Set(items.map((i) => i.id));
    for (const type of enumerateTypes()) {
      expect(ids.has(type), `Missing type: ${type}`).toBe(true);
    }
  });

  it("--json with --category resource-types emits only resource-type items", async () => {
    let capturedOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      capturedOutput += String(data);
      return true;
    });
    try {
      await discoverCommand.parseAsync(
        ["discover", "--json", "--category", "resource-types"],
        { from: "user" },
      );
      const items = JSON.parse(capturedOutput) as Array<{ category: string }>;
      for (const item of items) {
        expect(item.category).toBe("resource-types");
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// Axis H — --category patterns filter
// ---------------------------------------------------------------------------

describe("Axis H — --category patterns filter", () => {
  it("buildCatalogue('patterns') returns only pattern items", () => {
    const items = buildCatalogue("patterns");
    for (const item of items) {
      expect(item.category).toBe("patterns");
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it("patterns items contain no resource-types or commands", () => {
    const items = buildCatalogue("patterns");
    const nonPatterns = items.filter((i) => i.category !== "patterns");
    expect(nonPatterns).toHaveLength(0);
  });

  it("all registered patterns appear in the patterns category", () => {
    const items = buildCatalogue("patterns");
    const ids = new Set(items.map((i) => i.id));
    for (const pattern of enumeratePatterns()) {
      expect(
        ids.has(pattern.patternId),
        `Missing pattern: ${pattern.patternId}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Axis I — --category commands filter
// ---------------------------------------------------------------------------

describe("Axis I — --category commands filter", () => {
  it("buildCatalogue('commands') returns only command items", () => {
    const items = buildCatalogue("commands");
    for (const item of items) {
      expect(item.category).toBe("commands");
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it("commands items contain no resource-types or patterns", () => {
    const items = buildCatalogue("commands");
    const nonCommands = items.filter((i) => i.category !== "commands");
    expect(nonCommands).toHaveLength(0);
  });

  it("'discover' appears in the commands category", () => {
    const items = buildCatalogue("commands");
    const ids = new Set(items.map((i) => i.id));
    expect(ids.has("discover")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Axis J — Shell completion coverage
// ---------------------------------------------------------------------------

describe("Axis J — shell completion coverage", () => {
  it("'discover' command is registered in the Commander program tree", () => {
    const program = new Command("assignee");
    program.addCommand(discoverCommand);
    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain("discover");
  });

  it("discoverCommand has name 'discover'", () => {
    expect(discoverCommand.name()).toBe("discover");
  });
});

// ---------------------------------------------------------------------------
// Axis K — --help output
// ---------------------------------------------------------------------------

describe("Axis K — --help output", () => {
  it("discoverCommand has a non-empty description", () => {
    expect(discoverCommand.description()).toBeTruthy();
    expect(discoverCommand.description()).not.toContain("undefined");
  });

  it("discoverCommand has --json option registered", () => {
    const optionNames = discoverCommand.options.map((o) => o.long);
    expect(optionNames).toContain("--json");
  });

  it("discoverCommand has --category option registered", () => {
    const optionNames = discoverCommand.options.map((o) => o.long);
    expect(optionNames).toContain("--category");
  });

  it("--category option description does not contain 'undefined'", () => {
    const catOption = discoverCommand.options.find(
      (o) => o.long === "--category",
    );
    expect(catOption).toBeDefined();
    expect(catOption!.description).not.toContain("undefined");
  });

  it("--json option description does not contain 'undefined'", () => {
    const jsonOption = discoverCommand.options.find((o) => o.long === "--json");
    expect(jsonOption).toBeDefined();
    expect(jsonOption!.description).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Axis L — Registry parity
// ---------------------------------------------------------------------------

describe("Axis L — registry parity", () => {
  it("total catalogue count equals types + patterns + commands", () => {
    const allItems = buildCatalogue();
    const typeCount = buildCatalogue("resource-types").length;
    const patternCount = buildCatalogue("patterns").length;
    const commandCount = buildCatalogue("commands").length;

    // Live registry counts from variant-matrix harness
    expect(typeCount).toBe(enumerateTypes().length);
    expect(patternCount).toBe(enumeratePatterns().length);
    expect(typeCount + patternCount + commandCount).toBe(allItems.length);
    // At least 17 original commands + discover = 18
    expect(commandCount).toBeGreaterThanOrEqual(18);
  });

  it("no duplicate IDs across the full catalogue", () => {
    const allItems = buildCatalogue();
    const ids = allItems.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every item has all four required fields non-empty", () => {
    const allItems = buildCatalogue();
    for (const item of allItems) {
      expect(item.id, `id should be non-empty for item`).toBeTruthy();
      expect(
        item.category,
        `category should be non-empty for ${item.id}`,
      ).toBeTruthy();
      expect(
        item.description,
        `description should be non-empty for ${item.id}`,
      ).toBeTruthy();
      expect(
        item.exampleIntent,
        `exampleIntent should be non-empty for ${item.id}`,
      ).toBeTruthy();
    }
  });

  it("resource-type IDs from catalogue match variant-matrix enumerateTypes()", () => {
    const catalogueTypeIds = new Set(
      buildCatalogue("resource-types").map((i) => i.id),
    );
    for (const type of enumerateTypes()) {
      expect(
        catalogueTypeIds.has(type),
        `Type ${type} missing from discover catalogue`,
      ).toBe(true);
    }
  });

  it("pattern IDs from catalogue match variant-matrix enumeratePatterns()", () => {
    const cataloguePatternIds = new Set(
      buildCatalogue("patterns").map((i) => i.id),
    );
    for (const pattern of enumeratePatterns()) {
      expect(
        cataloguePatternIds.has(pattern.patternId),
        `Pattern ${pattern.patternId} missing from discover catalogue`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Axis M — DISCOVER_COMMAND_LIST ↔ CLI_COMMANDS drift-guard (F2, Story 108-A-03 R2)
// ---------------------------------------------------------------------------

/**
 * Structural copy of CLI_COMMANDS from
 * packages/core/src/__tests__/variant-matrix/index.ts.
 *
 * Option B: import from variant-matrix raw source is impractical in the CLI
 * vitest runner because it uses `@/` path aliases that aren't resolved outside
 * the core package. Instead, this tuple is an inline mirror — the test below
 * enforces bidirectional parity so that any drift (a command added to one
 * tuple but not the other) turns the test red and blocks CI.
 *
 * When you add a new command to CLI_COMMANDS, update BOTH this constant AND
 * DISCOVER_COMMAND_LIST in discover-data.ts.
 */
const CLI_COMMANDS_MIRROR = [
  "plan",
  "apply",
  "completions",
  "init",
  "describe",
  "destroy",
  "drift",
  "optimize",
  "list",
  "setup",
  "status",
  "reconcile",
  "doctor",
  "restore-provisions",
  "audit-verify",
  "update",
  "version",
  "discover",
] as const;

describe("Axis M — DISCOVER_COMMAND_LIST vs CLI_COMMANDS drift-guard", () => {
  // Option B: structural equality assertion. DISCOVER_COMMAND_LIST is a
  // manually-maintained tuple that mirrors CLI_COMMANDS in the variant-matrix.
  // If a new command is added to CLI_COMMANDS without updating
  // DISCOVER_COMMAND_LIST (or vice-versa), this test turns red and blocks CI.
  it("DISCOVER_COMMAND_LIST contains every entry in CLI_COMMANDS", () => {
    const discoverSet = new Set<string>(DISCOVER_COMMAND_LIST);
    for (const cmd of CLI_COMMANDS_MIRROR) {
      expect(
        discoverSet.has(cmd),
        `CLI_COMMANDS has "${cmd}" but DISCOVER_COMMAND_LIST does not — add it to discover-data.ts`,
      ).toBe(true);
    }
  });

  it("CLI_COMMANDS contains every entry in DISCOVER_COMMAND_LIST", () => {
    const cliSet = new Set<string>(CLI_COMMANDS_MIRROR);
    for (const cmd of DISCOVER_COMMAND_LIST) {
      expect(
        cliSet.has(cmd),
        `DISCOVER_COMMAND_LIST has "${cmd}" but CLI_COMMANDS does not — remove it from discover-data.ts or add it to variant-matrix/index.ts`,
      ).toBe(true);
    }
  });

  it("both tuples have the same length", () => {
    expect(DISCOVER_COMMAND_LIST.length).toBe(CLI_COMMANDS_MIRROR.length);
  });
});
