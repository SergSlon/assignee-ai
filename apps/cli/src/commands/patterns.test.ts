import { describe, it, expect } from "vitest";
import { defaultPatternRegistry } from "@assignee/core";
import { renderPatternList, renderPatternDetail } from "./patterns.js";

// Exercises the pure render helpers. The command action paths (process.exit
// on unknown patternId, JSON output mode) are covered by the integration
// smoke in cli-flow-matrix.test.ts via the command definition checks.

describe("patterns command — renderPatternList", () => {
  it("shows every registered pattern in insertion order", () => {
    const entries = defaultPatternRegistry.list().map((p) => ({
      patternId: p.patternId,
      displayName: p.displayName,
      resourceCount: p.resourceList.length,
      keywords: p.keywords,
    }));
    const out = renderPatternList(entries);

    // Count line mentions every registered pattern
    expect(out).toContain(`${entries.length} compound pattern`);

    // First-registered pattern is serverless-api (by current
    // pattern-templates/index.ts registration order)
    const serverlessIdx = out.indexOf("serverless-api");
    const lambdaWithExecIdx = out.indexOf("lambda-with-exec-role");
    expect(serverlessIdx).toBeGreaterThanOrEqual(0);
    expect(lambdaWithExecIdx).toBeGreaterThan(serverlessIdx);

    // Scheduled-lambda must appear BEFORE lambda-with-exec-role so the
    // precedence-matters guidance renders correctly.
    const scheduledIdx = out.indexOf("scheduled-lambda");
    expect(scheduledIdx).toBeGreaterThanOrEqual(0);
    expect(scheduledIdx).toBeLessThan(lambdaWithExecIdx);

    // The "run patterns show" hint is always at the bottom
    expect(
      out.trimEnd().endsWith("for the full resource list + dependency order."),
    ).toBe(true);
  });

  it("shows 'no patterns' for an empty registry", () => {
    const out = renderPatternList([]);
    expect(out).toContain("No compound patterns registered");
  });

  it("uses singular 'pattern' label when count is 1", () => {
    const out = renderPatternList([
      {
        patternId: "solo",
        displayName: "Solo Pattern",
        resourceCount: 1,
        keywords: ["solo"],
      },
    ]);
    expect(out).toContain("1 compound pattern");
    expect(out).not.toContain("1 compound patterns");
  });

  it("truncates the keywords preview to 3 and shows the remainder as +N more", () => {
    const out = renderPatternList([
      {
        patternId: "x",
        displayName: "X",
        resourceCount: 1,
        keywords: ["a", "b", "c", "d", "e"],
      },
    ]);
    expect(out).toContain('"a", "b", "c"');
    expect(out).toContain("+2 more");
  });
});

describe("patterns command — renderPatternDetail", () => {
  it("renders scheduled-lambda with its 4 resources, 4 dependency groups, and 12 keywords", () => {
    const pattern = defaultPatternRegistry.get("scheduled-lambda")!;
    expect(pattern).toBeTruthy();

    const detail = {
      patternId: pattern.patternId,
      displayName: pattern.displayName,
      resourceCount: pattern.resourceList.length,
      keywords: pattern.keywords,
      resources: pattern.resourceList.map((r) => ({
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        displayName: r.displayName,
        provisionable: r.provisionable !== false,
      })),
      dependencyOrder: pattern.dependencyOrder,
    };
    const out = renderPatternDetail(detail);

    expect(out).toContain("scheduled-lambda");
    expect(out).toContain("Resources (4, 1 display-only)");
    expect(out).toContain("iam-execution-role (AWS::IAM::Role)");
    expect(out).toContain("lambda-fn (AWS::Lambda::Function)");
    expect(out).toContain("schedule-rule (AWS::Events::Rule)");
    expect(out).toContain(
      "⚠ display-only: invoke-permission (AWS::Lambda::Permission)",
    );

    expect(out).toContain("Dependency order (4 groups)");
    expect(out).toContain("1. iam-execution-role");
    expect(out).toContain("2. lambda-fn");
    expect(out).toContain("3. schedule-rule");
    expect(out).toContain("4. invoke-permission");

    // All 12 scheduled-lambda keywords must be listed
    for (const kw of pattern.keywords) {
      expect(out).toContain(`"${kw}"`);
    }
  });

  it("shows efs-with-vpc as fully provisionable (no display-only suffix)", () => {
    const pattern = defaultPatternRegistry.get("efs-with-vpc")!;
    const detail = {
      patternId: pattern.patternId,
      displayName: pattern.displayName,
      resourceCount: pattern.resourceList.length,
      keywords: pattern.keywords,
      resources: pattern.resourceList.map((r) => ({
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        displayName: r.displayName,
        provisionable: r.provisionable !== false,
      })),
      dependencyOrder: pattern.dependencyOrder,
    };
    const out = renderPatternDetail(detail);
    expect(out).toContain("Resources (10)");
    expect(out).not.toContain("display-only");
  });
});
