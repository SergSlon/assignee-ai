/**
 * Tests for `apps/cli/scripts/doc-lint.mjs` — Story 56-it1-04.
 *
 * Verifies the narrative-count drift linter flags drift when README
 * pattern-table row counts or integration-architecture narrative
 * counts disagree with runtime registry values. Closes the L3-002
 * "linter scope incomplete" finding.
 *
 * Instead of shelling out to the script, we import the exported
 * helpers directly and feed them drifted in-memory document strings.
 * This keeps the test fast and deterministic — no child process, no
 * temp-dir cleanup, no dependency on a fresh `pnpm build`.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countReadmePatternRows,
  extractIntegrationArchitectureCounts,
  runDocLint,
} from "../../scripts/doc-lint.mjs";

// ── Realistic runtime-count fixtures ────────────────────────────────
// Epic 56 iteration 1 baseline: 37 types, 10 patterns, 37 strategies,
// 37 decomposers. Using real values keeps the mocks honest (global
// rule: "ALL mocks must use real data").
const RUNTIME_COUNTS = {
  supportedTypeCount: 37,
  patternCount: 10,
  strategyCount: 37,
  decomposerCount: 37,
} as const;

const CLEAN_README = `# Assignee.ai

## Supported resource types

### Compound architecture patterns

| Pattern              | Resources                     | Trigger keywords |
| :------------------- | :---------------------------- | :--------------- |
| VPC Networking       | VPC → Subnets                 | "vpc"            |
| Serverless API       | Lambda → API GW               | "lambda api"     |
| Static Website       | S3 + CloudFront               | "static website" |
| Message Processing   | SQS + Lambda                  | "queue"          |
| Three-Tier Web       | VPC + ECS + ALB               | "three tier"     |
| Container Service    | ECR + ECS                     | "container"      |
| EFS with private VPC | VPC + EFS                     | "efs"            |
| Scheduled Lambda     | Lambda + EventBridge          | "cron"           |
| Lambda + Exec Role   | IAM + Lambda                  | "lambda"         |
| VPC Public-Only      | VPC + IGW                     | "public vpc"     |

---
`;

const CLEAN_INTEGRATION_ARCH = `# Integration Architecture

- All 37 user-addressable resource type constants
- Resource plugin registry (37 registered plugins: 35 type-specific + generic fallback)
- Pattern template registry (10 compound architecture patterns)
- Pricing strategy registry (37 strategies) and decomposer registry (37 decomposers)
`;

describe("doc-lint — countReadmePatternRows", () => {
  it("counts the 10 rows in the canonical clean fixture", () => {
    expect(countReadmePatternRows(CLEAN_README)).toBe(10);
  });

  it("returns null when the pattern-table header is missing", () => {
    const noTable =
      "# README without the compound-patterns table\n\nSome prose.\n";
    expect(countReadmePatternRows(noTable)).toBeNull();
  });

  it("returns null when the divider row is malformed", () => {
    const broken = `# README

| Pattern | Resources |
not a divider
| X | Y |
`;
    expect(countReadmePatternRows(broken)).toBeNull();
  });

  it("stops counting at blank line so trailing prose does not inflate the count", () => {
    const readme = `# R

| Pattern | X |
| :------ | :- |
| A       | 1  |
| B       | 2  |

Trailing prose that must not count.
| C | Z |
`;
    expect(countReadmePatternRows(readme)).toBe(2);
  });
});

describe("doc-lint — extractIntegrationArchitectureCounts", () => {
  it("extracts every guarded narrative count from the clean fixture", () => {
    const result = extractIntegrationArchitectureCounts(CLEAN_INTEGRATION_ARCH);
    const byLabel = Object.fromEntries(
      result.map((r: { label: string; actual: number | null }) => [
        r.label,
        r.actual,
      ]),
    );
    expect(byLabel["user-addressable resource types"]).toBe(37);
    expect(byLabel["registered plugins"]).toBe(37);
    expect(byLabel["compound architecture patterns"]).toBe(10);
    expect(byLabel["pricing strategies"]).toBe(37);
    expect(byLabel["pricing decomposers"]).toBe(37);
  });

  it("returns null actuals when prose was rewritten and the regex no longer matches", () => {
    const scrambled = "# Doc with no guarded narrative counts\n";
    const result = extractIntegrationArchitectureCounts(scrambled);
    for (const r of result) {
      expect(r.actual).toBeNull();
    }
  });
});

describe("doc-lint — runDocLint (end-to-end drift detection)", () => {
  async function writeFixture(name: string, content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "doc-lint-"));
    const path = join(dir, name);
    await writeFile(path, content, "utf8");
    return path;
  }

  it("returns zero errors for matching clean fixtures", async () => {
    const readmePath = await writeFixture("README.md", CLEAN_README);
    const integrationArchPath = await writeFixture(
      "integration-architecture.md",
      CLEAN_INTEGRATION_ARCH,
    );
    const errors = await runDocLint({
      readmePath,
      integrationArchPath,
      runtimeCounts: RUNTIME_COUNTS,
      crossDocTargets: [],
    });
    expect(errors).toEqual([]);
  });

  it("flags a drifted README pattern-table row count", async () => {
    // Drop one pattern row → 9 rows vs runtime 10.
    const drifted = CLEAN_README.replace(
      '| VPC Public-Only      | VPC + IGW                     | "public vpc"     |\n',
      "",
    );
    const readmePath = await writeFixture("README.md", drifted);
    const integrationArchPath = await writeFixture(
      "integration-architecture.md",
      CLEAN_INTEGRATION_ARCH,
    );
    const errors = await runDocLint({
      readmePath,
      integrationArchPath,
      runtimeCounts: RUNTIME_COUNTS,
      crossDocTargets: [],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/README pattern-table has 9 rows but .* === 10/);
  });

  it("flags a drifted integration-architecture strategy count", async () => {
    // "37 strategies" drifted to "23 strategies" (the actual Epic 56 finding)
    const drifted = CLEAN_INTEGRATION_ARCH.replace(
      "(37 strategies)",
      "(23 strategies)",
    );
    const readmePath = await writeFixture("README.md", CLEAN_README);
    const integrationArchPath = await writeFixture(
      "integration-architecture.md",
      drifted,
    );
    const errors = await runDocLint({
      readmePath,
      integrationArchPath,
      runtimeCounts: RUNTIME_COUNTS,
      crossDocTargets: [],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/pricing strategies.*says 23.*reports 37/);
  });

  it("flags a missing narrative count (prose rewrite escape)", async () => {
    // Remove the pattern-template sentence entirely. Expected behaviour:
    // treated as drift so prose rewrites can't silently bypass the guard.
    const drifted = CLEAN_INTEGRATION_ARCH.replace(
      "- Pattern template registry (10 compound architecture patterns)\n",
      "",
    );
    const readmePath = await writeFixture("README.md", CLEAN_README);
    const integrationArchPath = await writeFixture(
      "integration-architecture.md",
      drifted,
    );
    const errors = await runDocLint({
      readmePath,
      integrationArchPath,
      runtimeCounts: RUNTIME_COUNTS,
      crossDocTargets: [],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"compound architecture patterns" not found/);
  });

  it("flags drift in a cross-doc target file (e.g. testing-guide narrative)", async () => {
    // Write a fake testing-guide.md under a tmp repo root and exercise
    // the cross-doc walker. The fixture asserts "All 23 supported
    // resource types" while RUNTIME_COUNTS pins 37 — drift expected.
    const tmpRoot = await mkdtemp(join(tmpdir(), "doc-lint-cross-"));
    const docsDir = join(tmpRoot, "docs");
    await writeFile(join(tmpRoot, "README.md"), CLEAN_README, "utf8");
    await writeFile(
      join(tmpRoot, "integration-architecture.md"),
      CLEAN_INTEGRATION_ARCH,
      "utf8",
    );
    await import("node:fs").then((fs) =>
      fs.promises.mkdir(docsDir, { recursive: true }),
    );
    await writeFile(
      join(docsDir, "testing-guide.md"),
      "All 23 supported resource types flow through CCAPI.\n",
      "utf8",
    );
    const errors = await runDocLint({
      readmePath: join(tmpRoot, "README.md"),
      integrationArchPath: join(tmpRoot, "integration-architecture.md"),
      runtimeCounts: RUNTIME_COUNTS,
      repoRoot: tmpRoot,
      crossDocTargets: ["docs/testing-guide.md"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /testing-guide\.md.*23.*supported resource types.*runtime.*37/,
    );
  });

  it("accumulates multiple drift errors in one run", async () => {
    const driftedReadme = CLEAN_README.replace(
      '| VPC Public-Only      | VPC + IGW                     | "public vpc"     |\n',
      "",
    );
    const driftedArch = CLEAN_INTEGRATION_ARCH.replace(
      "(37 strategies)",
      "(23 strategies)",
    ).replace("(37 decomposers)", "(23 decomposers)");
    const readmePath = await writeFixture("README.md", driftedReadme);
    const integrationArchPath = await writeFixture(
      "integration-architecture.md",
      driftedArch,
    );
    const errors = await runDocLint({
      readmePath,
      integrationArchPath,
      runtimeCounts: RUNTIME_COUNTS,
      crossDocTargets: [],
    });
    expect(errors).toHaveLength(3);
  });
});
