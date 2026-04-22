/**
 * Tests for the shared `--resource-type` filter helper used by `list` /
 * `status`. Covers HEADLINE_SHORTHANDS resolution, SSO validation, and
 * the P2-01 ambiguous-shorthand warning (Story 56-it2-04).
 *
 * Story e92.u.b (F-A-04): regression-pins for existing shorthands +
 * targeted coverage for the six new service-level shorthands (`sns`,
 * `ec2`, `vpc`, `eventbridge`, `cloudwatch`, `cloudfront`) and every
 * CFN type under those services so an ambiguous-shorthand landing
 * doesn't smudge the exact-CFN-form round-trip contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import {
  INVALID_RESOURCE_TYPE_CODE,
  normaliseResourceType,
  resolveResourceTypeFilter,
} from "./resource-type-filter.js";

describe("resolveResourceTypeFilter — exact + shorthand matches", () => {
  it("returns the canonical CFN form for an exact supported type (case-insensitive)", () => {
    expect(resolveResourceTypeFilter("AWS::S3::Bucket")).toBe(
      "AWS::S3::Bucket",
    );
    expect(resolveResourceTypeFilter("aws::s3::bucket")).toBe(
      "AWS::S3::Bucket",
    );
  });

  it("rejects unknown types with INVALID_RESOURCE_TYPE_CODE and embeds the SSO hint", () => {
    try {
      resolveResourceTypeFilter("NOT::A::Type");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code: string }).code).toBe(INVALID_RESOURCE_TYPE_CODE);
      expect((err as Error).message).toContain(
        'Unknown --resource-type "NOT::A::Type"',
      );
      // SSO hint header (registry-derived).
      expect((err as Error).message).toContain("What you can create");
    }
  });
});

describe("normaliseResourceType — P2-01 ambiguous-shorthand warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when shorthand resolves to a service that has >1 supported CFN types", () => {
    // Precondition: RDS owns both DBInstance AND DBSubnetGroup in the
    // registry — without this, the test wouldn't exercise the warning
    // path and would give a false-positive pass.
    const rdsTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::RDS::"),
    );
    expect(rdsTypes.length).toBeGreaterThan(1);

    const resolved = normaliseResourceType("rds");
    expect(resolved).toBe("AWS::RDS::DBInstance");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const message = warnSpy.mock.calls[0]![0] as string;
    expect(message).toContain('"rds"');
    expect(message).toContain("AWS::RDS::DBInstance");
    // Mentions the sibling RDS type(s) by name.
    const siblings = rdsTypes.filter((t) => t !== "AWS::RDS::DBInstance");
    for (const sibling of siblings) {
      expect(message).toContain(sibling);
    }
  });

  it("does NOT warn when the shorthand's service has exactly one supported type", () => {
    // Lambda owns only AWS::Lambda::Function in the registry, so the
    // `lambda` shorthand is unambiguous and should NOT fire the
    // ambiguous-shorthand warning.
    const lambdaTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::Lambda::"),
    );
    expect(lambdaTypes).toEqual(["AWS::Lambda::Function"]);

    const resolved = normaliseResourceType("lambda");
    expect(resolved).toBe("AWS::Lambda::Function");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn for exact CFN matches (user already typed the full form)", () => {
    const resolved = normaliseResourceType("AWS::RDS::DBInstance");
    expect(resolved).toBe("AWS::RDS::DBInstance");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("normaliseResourceType — Story e92.u.b new service-level shorthands (F-A-04)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("resolves `sns` → AWS::SNS::Topic and warns about AWS::SNS::Subscription sibling", () => {
    // Precondition: SNS owns both Topic AND Subscription — warning must fire.
    const snsTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::SNS::"),
    );
    expect(snsTypes).toContain("AWS::SNS::Topic");
    expect(snsTypes).toContain("AWS::SNS::Subscription");

    expect(normaliseResourceType("sns")).toBe("AWS::SNS::Topic");
    expect(normaliseResourceType("SNS")).toBe("AWS::SNS::Topic");
    // Two calls above, both warn.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const message = warnSpy.mock.calls[0]![0] as string;
    expect(message).toContain("AWS::SNS::Subscription");
  });

  it("resolves `ec2` → AWS::EC2::Instance and warns about the many EC2 siblings", () => {
    const ec2Types = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::EC2::"),
    );
    expect(ec2Types.length).toBeGreaterThan(1);

    expect(normaliseResourceType("ec2")).toBe("AWS::EC2::Instance");
    expect(normaliseResourceType("EC2")).toBe("AWS::EC2::Instance");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const message = warnSpy.mock.calls[0]![0] as string;
    // All EC2 siblings (everything except Instance) must be named.
    for (const sibling of ec2Types.filter((t) => t !== "AWS::EC2::Instance")) {
      expect(message).toContain(sibling);
    }
  });

  it("resolves `vpc` → AWS::EC2::VPC and warns about EC2 siblings", () => {
    const ec2Types = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::EC2::"),
    );
    expect(ec2Types).toContain("AWS::EC2::VPC");
    expect(ec2Types.length).toBeGreaterThan(1);

    expect(normaliseResourceType("vpc")).toBe("AWS::EC2::VPC");
    expect(normaliseResourceType("VPC")).toBe("AWS::EC2::VPC");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const message = warnSpy.mock.calls[0]![0] as string;
    // Every EC2 type that is NOT VPC must be named as a sibling.
    for (const sibling of ec2Types.filter((t) => t !== "AWS::EC2::VPC")) {
      expect(message).toContain(sibling);
    }
  });

  it("resolves `eventbridge` → AWS::Events::Rule and warns about Events siblings", () => {
    // Precondition: Events owns Rule + EventBus + Connection + ApiDestination.
    const eventsTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::Events::"),
    );
    expect(eventsTypes).toContain("AWS::Events::Rule");
    expect(eventsTypes.length).toBeGreaterThan(1);

    expect(normaliseResourceType("eventbridge")).toBe("AWS::Events::Rule");
    expect(normaliseResourceType("EventBridge")).toBe("AWS::Events::Rule");
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const message = warnSpy.mock.calls[0]![0] as string;
    for (const sibling of eventsTypes.filter(
      (t) => t !== "AWS::Events::Rule",
    )) {
      expect(message).toContain(sibling);
    }
  });

  it("resolves `cloudwatch` → AWS::CloudWatch::Alarm without firing the ambiguity warning", () => {
    // Precondition: CloudWatch owns exactly one supported type (Alarm).
    const cwTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::CloudWatch::"),
    );
    expect(cwTypes).toEqual(["AWS::CloudWatch::Alarm"]);

    expect(normaliseResourceType("cloudwatch")).toBe("AWS::CloudWatch::Alarm");
    expect(normaliseResourceType("CloudWatch")).toBe("AWS::CloudWatch::Alarm");
    // Single-type service — no warning.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("resolves `cloudfront` → AWS::CloudFront::Distribution and warns about OriginAccessControl sibling", () => {
    const cfTypes = SUPPORTED_TYPES_ARRAY.filter((t) =>
      t.startsWith("AWS::CloudFront::"),
    );
    expect(cfTypes).toContain("AWS::CloudFront::Distribution");
    expect(cfTypes).toContain("AWS::CloudFront::OriginAccessControl");

    expect(normaliseResourceType("cloudfront")).toBe(
      "AWS::CloudFront::Distribution",
    );
    expect(normaliseResourceType("CloudFront")).toBe(
      "AWS::CloudFront::Distribution",
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    const message = warnSpy.mock.calls[0]![0] as string;
    expect(message).toContain("AWS::CloudFront::OriginAccessControl");
  });
});

describe("normaliseResourceType — regression pins for pre-existing shorthands", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence the P2-01 warning spam — regression-pins only assert the
    // return value, not the warning surface.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each([
    ["s3", "AWS::S3::Bucket"],
    ["lambda", "AWS::Lambda::Function"],
    ["dynamodb", "AWS::DynamoDB::Table"],
    ["sqs", "AWS::SQS::Queue"],
    ["rds", "AWS::RDS::DBInstance"],
    ["iam", "AWS::IAM::Role"],
    ["ecs", "AWS::ECS::Cluster"],
    ["ecr", "AWS::ECR::Repository"],
    ["kms", "AWS::KMS::Key"],
  ])("existing shorthand `%s` still resolves to %s", (shorthand, expected) => {
    expect(normaliseResourceType(shorthand)).toBe(expected);
    // The expected CFN type must still live in the registry — guards
    // against someone removing a supported type without updating the
    // shorthand map.
    expect(SUPPORTED_TYPES_ARRAY).toContain(expected);
  });
});

describe("normaliseResourceType — exact-CFN round-trip for types under shorthand services", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Each of these CFN types is under a service that gained a new
  // shorthand in Story e92.u.b. If step-1 (exact match) ever lost
  // precedence over the shorthand table, these would silently resolve
  // to the headline type — these pins prevent that.
  const underShorthandServices = [
    "AWS::SNS::Topic",
    "AWS::SNS::Subscription",
    "AWS::EC2::Instance",
    "AWS::EC2::VPC",
    "AWS::EC2::Subnet",
    "AWS::Events::Rule",
    "AWS::Events::EventBus",
    "AWS::Events::Connection",
    "AWS::Events::ApiDestination",
    "AWS::CloudWatch::Alarm",
    "AWS::CloudFront::Distribution",
  ] as const;

  it.each(underShorthandServices)(
    "exact CFN form `%s` round-trips unchanged",
    (cfnType) => {
      // Sanity-check the fixture — if the registry ever drops this
      // type, the test must be updated, not silently skip.
      expect(SUPPORTED_TYPES_ARRAY).toContain(cfnType);
      expect(normaliseResourceType(cfnType)).toBe(cfnType);
      // Exact matches must NOT trigger the ambiguity warning (step-1
      // returns before step-2 can fire).
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );
});
