import { describe, it, expect } from "vitest";
import { renderTypeList, renderTypeDetail } from "./types.js";

describe("types command — renderTypeList", () => {
  it("shows every type in iteration order", () => {
    const out = renderTypeList([
      {
        resourceType: "AWS::S3::Bucket",
        shortName: "S3 Bucket",
        commonFieldCount: 6,
        advancedFieldCount: 8,
        bpRuleCount: 14,
      },
      {
        resourceType: "AWS::Events::Rule",
        shortName: "Events Rule",
        commonFieldCount: 6,
        advancedFieldCount: 2,
        bpRuleCount: 3,
      },
    ]);
    expect(out).toContain("2 supported resource types");
    expect(out).toContain("AWS::S3::Bucket  (6+8 fields, 14 BP rules)");
    expect(out).toContain("AWS::Events::Rule  (6+2 fields, 3 BP rules)");
    expect(out.trimEnd().endsWith("full field + BP rule listing.")).toBe(true);
  });

  it("shows 'none' for an empty list", () => {
    expect(renderTypeList([])).toContain("No supported resource types");
  });

  it("uses singular 'type' label when count is 1", () => {
    const out = renderTypeList([
      {
        resourceType: "AWS::X::Y",
        shortName: "X Y",
        commonFieldCount: 0,
        advancedFieldCount: 0,
        bpRuleCount: 0,
      },
    ]);
    expect(out).toContain("1 supported resource type");
    expect(out).not.toContain("1 supported resource types");
  });
});

describe("types command — renderTypeDetail", () => {
  it("marks required fields with a leading * and unrequired with blank", () => {
    const out = renderTypeDetail({
      resourceType: "AWS::Test::Thing",
      shortName: "Test Thing",
      commonFieldCount: 2,
      advancedFieldCount: 0,
      bpRuleCount: 0,
      commonFields: [
        { name: "RequiredField", required: true },
        { name: "OptionalField", required: false },
      ],
      advancedFields: [],
      bpRules: [],
      hasPricingStrategy: true,
      primaryIdentifier: "Id",
      usedByPatterns: [],
    });
    expect(out).toContain("* RequiredField");
    expect(out).toContain("  OptionalField");
  });

  it("hides advanced-fields section when there are none", () => {
    const out = renderTypeDetail({
      resourceType: "AWS::Test::Thing",
      shortName: "Test Thing",
      commonFieldCount: 1,
      advancedFieldCount: 0,
      bpRuleCount: 0,
      commonFields: [{ name: "F", required: false }],
      advancedFields: [],
      bpRules: [],
      hasPricingStrategy: false,
      primaryIdentifier: "Id",
      usedByPatterns: [],
    });
    expect(out).not.toContain("Advanced fields");
  });

  it("shows a 'no BP coverage yet' note for types with zero rules", () => {
    const out = renderTypeDetail({
      resourceType: "AWS::Test::Thing",
      shortName: "Test Thing",
      commonFieldCount: 0,
      advancedFieldCount: 0,
      bpRuleCount: 0,
      commonFields: [],
      advancedFields: [],
      bpRules: [],
      hasPricingStrategy: false,
      primaryIdentifier: "Id",
      usedByPatterns: [],
    });
    expect(out).toContain("(none — this type has no BP coverage yet)");
  });

  it("lists BP rules with severity tag and title", () => {
    const out = renderTypeDetail({
      resourceType: "AWS::Events::Rule",
      shortName: "Events Rule",
      commonFieldCount: 0,
      advancedFieldCount: 0,
      bpRuleCount: 3,
      commonFields: [],
      advancedFields: [],
      bpRules: [
        {
          id: "BP-EVENTS-001",
          severity: "CRITICAL",
          title: "EventBridge Rule must declare at least one Target",
        },
        {
          id: "BP-EVENTS-003",
          severity: "MEDIUM",
          title: "EventBridge Rule State should be ENABLED at creation",
        },
      ],
      hasPricingStrategy: true,
      primaryIdentifier: "Arn",
      usedByPatterns: [
        {
          patternId: "scheduled-lambda",
          displayName: "Scheduled Lambda (EventBridge cron)",
        },
      ],
    });
    expect(out).toContain("[CRITICAL] BP-EVENTS-001");
    expect(out).toContain("[MEDIUM] BP-EVENTS-003");
    expect(out).toContain("Pricing strategy: registered");
    // Primary identifier is surfaced above the pricing line.
    expect(out).toContain("Primary identifier: Arn");
    // Reverse lookup surfaces the compound patterns that include this type.
    expect(out).toContain(
      "scheduled-lambda — Scheduled Lambda (EventBridge cron)",
    );
  });

  it("reports 'none' for pricing when no strategy registered", () => {
    const out = renderTypeDetail({
      resourceType: "AWS::Test::Thing",
      shortName: "Test Thing",
      commonFieldCount: 0,
      advancedFieldCount: 0,
      bpRuleCount: 0,
      commonFields: [],
      advancedFields: [],
      bpRules: [],
      hasPricingStrategy: false,
      primaryIdentifier: "Id",
      usedByPatterns: [],
    });
    expect(out).toContain("Pricing strategy: none");
    // Zero patterns → the "only provisioned directly" hint surfaces.
    expect(out).toContain("only provisioned directly");
  });
});
