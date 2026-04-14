import { describe, it, expect } from "vitest";
import { rdsDbSubnetGroupPlugin } from "./rds-db-subnet-group.js";

/**
 * Closes QA BLOCKER B4 (qa-expert-e2e-fixes.md). The plugin landed
 * without a co-located .test.ts; structural regressions (e.g. dropping
 * the description field, breaking tag CFN serialisation, removing
 * configHints) would only surface in live RDS apply runs. Mirrors the
 * shape used by sibling plugin tests (cloudwatch-alarm.test.ts).
 */
describe("rdsDbSubnetGroupPlugin", () => {
  it("has the canonical AWS::RDS::DBSubnetGroup resourceType", () => {
    expect(rdsDbSubnetGroupPlugin.resourceType).toBe("AWS::RDS::DBSubnetGroup");
  });

  it("declares both required common fields (description + tags)", () => {
    const names = rdsDbSubnetGroupPlugin.commonFields.map((f) => f.name);
    expect(names).toEqual(["DBSubnetGroupDescription", "Tags"]);
  });

  it("has no advanced fields (everything user-supplied lives in commonFields)", () => {
    expect(rdsDbSubnetGroupPlugin.advancedFields).toEqual([]);
  });

  it("defines no immutable defaults (CCAPI auto-generates name when omitted)", () => {
    // DBSubnetGroupName is intentionally NOT defaulted so CloudFormation
    // can auto-generate a unique name. Pin this so a future "let's
    // pre-fill the name" change has to acknowledge the createOnly +
    // immutable semantics from the schema.
    expect(rdsDbSubnetGroupPlugin.defaults).toEqual({});
  });

  describe("DBSubnetGroupDescription field", () => {
    const field = rdsDbSubnetGroupPlugin.commonFields.find(
      (f) => f.name === "DBSubnetGroupDescription",
    )!;

    it("exists and is a string question", () => {
      expect(field).toBeDefined();
      expect(field.question.type).toBe("string");
    });

    it("rejects an empty value with an actionable message", () => {
      // CCAPI rejects empty descriptions with a generic 400. The wizard
      // catches this earlier with a human-readable error.
      expect(field.question.validate?.("")).toBe("Description is required");
    });

    it("rejects a whitespace-only value (per .trim() guard)", () => {
      expect(field.question.validate?.("   ")).toBe("Description is required");
    });

    it("accepts a normal description string", () => {
      expect(
        field.question.validate?.("Subnets for production RDS"),
      ).toBeUndefined();
    });
  });

  describe("Tags field", () => {
    const field = rdsDbSubnetGroupPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("exists and is a string question (CSV input)", () => {
      expect(field).toBeDefined();
      expect(field.question.type).toBe("string");
    });

    it("toCfn returns undefined for empty / whitespace / non-string input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
      expect(field.toCfn?.("   ")).toBeUndefined();
      expect(field.toCfn?.(undefined)).toBeUndefined();
      expect(field.toCfn?.(null)).toBeUndefined();
      expect(field.toCfn?.(42)).toBeUndefined();
    });

    it("toCfn parses a single Key:Value pair into the CFN Tag object array", () => {
      // Real wizard input shape — the user types "key:value" pairs
      // separated by commas. The plugin must emit AWS's [{Key, Value}]
      // shape; a regression to {key, value} or "key=value" would fail
      // CCAPI's tag schema validation silently.
      expect(field.toCfn?.("env:production")).toEqual([
        { Key: "env", Value: "production" },
      ]);
    });

    it("toCfn parses multiple Key:Value pairs", () => {
      expect(field.toCfn?.("env:production, team:backend")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("toCfn preserves additional colons inside the Value (e.g. ARNs)", () => {
      // The implementation joins the rest of the split — pin this so a
      // future "split on first ':' only" refactor doesn't truncate ARN
      // values like arn:aws:s3:::bucket/key.
      const result = field.toCfn?.("source:arn:aws:s3:::my-bucket/key");
      expect(result).toEqual([
        { Key: "source", Value: "arn:aws:s3:::my-bucket/key" },
      ]);
    });

    it("toCfn drops malformed pairs that don't contain a colon", () => {
      // Real-world: users sometimes type "env=production" or just
      // "env". The plugin filters these out instead of emitting
      // malformed CFN that CCAPI will then reject.
      expect(field.toCfn?.("env=production, team:backend")).toEqual([
        { Key: "team", Value: "backend" },
      ]);
    });

    it("toCfn returns undefined when every pair is malformed", () => {
      // Empty array is not a valid CFN Tags value — must be undefined
      // so the field is omitted entirely from the CCAPI request.
      expect(field.toCfn?.("env=production")).toBeUndefined();
    });
  });

  describe("configHints", () => {
    it("exists and contains at least one entry", () => {
      expect(rdsDbSubnetGroupPlugin.configHints).toBeInstanceOf(Array);
      expect(rdsDbSubnetGroupPlugin.configHints!.length).toBeGreaterThan(0);
    });

    it("includes the multi-AZ subnet requirement (load-bearing for RDS Multi-AZ)", () => {
      const hints = rdsDbSubnetGroupPlugin.configHints!;
      expect(
        hints.some(
          (h) =>
            h.includes("SubnetIds") &&
            h.includes("2") &&
            h.includes("Availability Zones"),
        ),
      ).toBe(true);
    });

    it("includes the no-direct-cost note (BP / pricing displays rely on this)", () => {
      const hints = rdsDbSubnetGroupPlugin.configHints!;
      expect(hints.some((h) => h.includes("no direct cost"))).toBe(true);
    });
  });
});
