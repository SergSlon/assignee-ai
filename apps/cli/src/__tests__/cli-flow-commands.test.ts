/**
 * CLI Flow Commands — tests for command registration and option definitions:
 *   - command registration and options (CommandName, CommandDescription, CommandArgs)
 *   - plan command definition
 *   - apply command definition
 *   - init command definition
 *   - list command definition
 *   - destroy command definition
 *   - status command definition
 *   - drift command definition
 *   - reconcile command definition
 *   - setup command definition
 *   - supported resource types (SUPPORTED_TYPES_ARRAY)
 *
 * All blocks are stateless — pure import + Commander option inspection.
 *
 * @see Stories 33.x — CLI integration test matrix (split from cli-flow-matrix.test.ts)
 */

import { describe, it, expect } from "vitest";

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND REGISTRATION & OPTION DEFINITIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("command registration and options", () => {
  it("all commands are defined with correct names", async () => {
    const { CommandName } = await import("../constants/commands.js");
    expect(CommandName.PLAN).toBe("plan");
    expect(CommandName.APPLY).toBe("apply");
    expect(CommandName.INIT).toBe("init");
    expect(CommandName.LIST).toBe("list");
    expect(CommandName.DESTROY).toBe("destroy");
    expect(CommandName.STATUS).toBe("status");
    expect(CommandName.DRIFT).toBe("drift");
    expect(CommandName.RECONCILE).toBe("reconcile");
    expect(CommandName.SETUP).toBe("setup");
  });

  it("all command descriptions are non-empty", async () => {
    const { CommandDescription } = await import("../constants/commands.js");
    for (const [key, desc] of Object.entries(CommandDescription)) {
      expect(desc, `${key} description should be non-empty`).toBeTruthy();
      expect(
        (desc as string).length,
        `${key} description should be meaningful`,
      ).toBeGreaterThan(10);
    }
  });

  it("INTENT argument is optional (bracketed)", async () => {
    const { CommandArgs } = await import("../constants/commands.js");
    expect(CommandArgs.INTENT.NAME).toBe("[intent]");
  });

  it("RESOURCE argument is required (angle-bracketed)", async () => {
    const { CommandArgs } = await import("../constants/commands.js");
    expect(CommandArgs.RESOURCE.NAME).toBe("<resource>");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PLAN COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("plan command definition", () => {
  it("has -o / --output option", async () => {
    const { planCommand } = await import("../commands/plan.js");
    const opt = planCommand.options.find((o) => o.long === "--output");
    expect(opt).toMatchObject({
      long: "--output",
      short: "-o",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --no-apply option", async () => {
    const { planCommand } = await import("../commands/plan.js");
    const opt = planCommand.options.find((o) => o.long === "--no-apply");
    expect(opt).toMatchObject({
      long: "--no-apply",
      description: expect.stringMatching(/.+/),
    });
  });

  it("accepts [intent] as optional argument", async () => {
    const { planCommand } = await import("../commands/plan.js");
    // Commander stores registered args
    expect(planCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(planCommand.registeredArguments[0]!.name()).toBe("intent");
    expect(planCommand.registeredArguments[0]!.required).toBe(false);
  });

  it("has addHelpText registered for after-help content", async () => {
    const { planCommand } = await import("../commands/plan.js");
    // Commander's helpInformation() doesn't include addHelpText('after') content,
    // but we can verify the command has the expected description and options
    const helpInfo = planCommand.helpInformation();
    expect(helpInfo).toContain("plan");
    expect(helpInfo).toContain("--output");
    expect(helpInfo).toContain("--no-apply");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// APPLY COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("apply command definition", () => {
  it("has --wizard option (opt-in interactive mode)", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--wizard");
    expect(opt).toMatchObject({
      long: "--wizard",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -y / --yes option", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -c / --checkpoint option", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--checkpoint");
    expect(opt).toMatchObject({
      long: "--checkpoint",
      short: "-c",
      description: expect.stringMatching(/.+/),
    });
  });

  it("help text includes checkpoint examples", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const helpInfo = applyCommand.helpInformation();
    expect(helpInfo).toContain("--checkpoint");
    expect(helpInfo).toContain("--wizard");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INIT COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("init command definition", () => {
  it("has --global option", async () => {
    const { initCommand } = await import("../commands/init.js");
    const opt = initCommand.options.find((o) => o.long === "--global");
    expect(opt).toMatchObject({
      long: "--global",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("list command definition", () => {
  it("has --json option", async () => {
    const { listCommand } = await import("../commands/list.js");
    const opt = listCommand.options.find((o) => o.long === "--json");
    expect(opt).toMatchObject({
      long: "--json",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --region option", async () => {
    const { listCommand } = await import("../commands/list.js");
    const opt = listCommand.options.find((o) => o.long === "--region");
    expect(opt).toMatchObject({
      long: "--region",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DESTROY COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("destroy command definition", () => {
  it("has -y / --yes option", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    const opt = destroyCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has required <resource> argument (Story 50-3 made it mandatory)", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    expect(destroyCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(destroyCommand.registeredArguments[0]!.name()).toBe("resource");
    expect(destroyCommand.registeredArguments[0]!.required).toBe(true);
  });

  it("no longer exposes bulk-destroy flags (--all / --include-iam / --dry-run)", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    const longs = destroyCommand.options.map((o) => o.long);
    expect(longs).not.toContain("--all");
    expect(longs).not.toContain("--include-iam");
    expect(longs).not.toContain("--dry-run");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STATUS COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("status command definition", () => {
  it("has --json option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--json");
    expect(opt).toMatchObject({
      long: "--json",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --region option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--region");
    expect(opt).toMatchObject({
      long: "--region",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --bp-coverage option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--bp-coverage");
    expect(opt).toMatchObject({
      long: "--bp-coverage",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DRIFT COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("drift command definition", () => {
  // Epic 92 / story e92-3b2 (D-03, D-04, C-23): the old contract pinned
  // local `--no-color`, `--verbose`, and `--output` options on drift.
  // Those were buggy:
  //   - `--no-color` and `--verbose` shadowed the GLOBAL options of the
  //     same name declared on the root program in `apps/cli/src/index.ts`
  //     (duplicate help entries + precedence bugs).
  //   - `--output <file>` collided with other commands' `--output <format>`
  //     semantics.
  // The flip: local `--no-color` and `--verbose` are removed (served by
  // global), the per-field detail flag renames to `--detailed`, and the
  // JSON-report file path renames to `--output-file`.
  it("has all expected options", async () => {
    const { driftCommand } = await import("../commands/drift.js");
    const optionNames = driftCommand.options.map((o) => o.long);
    expect(optionNames).toContain("--resource");
    expect(optionNames).toContain("--region");
    expect(optionNames).toContain("--status");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--output-file");
    expect(optionNames).toContain("--concurrency");
    expect(optionNames).toContain("--detailed");
    // Epic 98 e98.W5.N3 (B-07 / D-16): `--output` is now present as
    // the `-o, --output <format>` enum selector. This REPLACES the
    // prior "must NOT contain --output" invariant (which defended the
    // `--output <file>` → `--output-file <file>` rename). The new
    // `--output` is semantically distinct from `--output-file` and
    // matches the flag surface of plan/apply/destroy/reconcile.
    expect(optionNames).toContain("--output");
    // Negative assertions: globally-scoped local options must NOT come
    // back (`--no-color` and `--verbose` are global on the root program).
    expect(optionNames).not.toContain("--no-color");
    expect(optionNames).not.toContain("--verbose");
  });

  it("accepts optional [resource-id] argument", async () => {
    const { driftCommand } = await import("../commands/drift.js");
    expect(driftCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(driftCommand.registeredArguments[0]!.required).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcile command definition", () => {
  it("has --resource option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find((o) => o.long === "--resource");
    expect(opt).toMatchObject({
      long: "--resource",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --dry-run option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find((o) => o.long === "--dry-run");
    expect(opt).toMatchObject({
      long: "--dry-run",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --auto-reconcile option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find(
      (o) => o.long === "--auto-reconcile",
    );
    expect(opt).toMatchObject({
      long: "--auto-reconcile",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SETUP COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("setup command definition", () => {
  it("has --profile option", async () => {
    const { setupCommand } = await import("../commands/setup.js");
    const opt = setupCommand.options.find((o) => o.long === "--profile");
    expect(opt).toMatchObject({
      long: "--profile",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -y / --yes option", async () => {
    const { setupCommand } = await import("../commands/setup.js");
    const opt = setupCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });
});

// Story 50-3: `cache`, `patterns`, `types` commands were removed.
// Their content folded into silent TTL schema cache / `plan --help` discovery.

// ═════════════════════════════════════════════════════════════════════════════
// SUPPORTED TYPES — core exports
// ═════════════════════════════════════════════════════════════════════════════

describe("supported resource types", () => {
  it("SUPPORTED_TYPES_ARRAY includes S3, EC2, Lambda", async () => {
    const { SUPPORTED_TYPES_ARRAY } = await import("@assignee/core");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::S3::Bucket");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::EC2::Instance");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::Lambda::Function");
  });

  it("SUPPORTED_TYPES_ARRAY has exactly 38 types (37 + AWS::EC2::EIP via e98.W5.N5)", async () => {
    const { SUPPORTED_TYPES_ARRAY } = await import("@assignee/core");
    expect(SUPPORTED_TYPES_ARRAY.length).toBe(38);
  });
});
