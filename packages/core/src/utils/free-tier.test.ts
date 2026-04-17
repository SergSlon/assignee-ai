/**
 * Tests for free-tier.ts (Story 7.8, AC #7).
 * Verifies free tier note generation for each FreeTierNote type,
 * null returns for unknown resources, and config file reading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs before importing the module under test
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";
import {
  getFreeTierNote,
  loadAccountCreatedDate,
  _resetAccountDateCache,
} from "./free-tier.js";

// ── getFreeTierNote tests ────────────────────────────────────────────────────

describe("getFreeTierNote", () => {
  it("returns always_free for IAM::Role", () => {
    const result = getFreeTierNote("AWS::IAM::Role");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for SSM::Parameter", () => {
    const result = getFreeTierNote("AWS::SSM::Parameter");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("Always free tier"),
    });
  });

  it("returns always_free for DynamoDB::Table", () => {
    const result = getFreeTierNote("AWS::DynamoDB::Table");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("25 GB"),
    });
  });

  it("returns always_free for Lambda::Function (always free with limits)", () => {
    const result = getFreeTierNote("AWS::Lambda::Function");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("1M requests/month"),
    });
  });

  it("returns legacy_eligible for EC2::Instance with pre-July-2025 account within 12 months", () => {
    // Use a date that is definitely within 12 months of today (dynamic)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const accountDate = sixMonthsAgo.toISOString().slice(0, 10);
    // Ensure account date is before the July 2025 cutoff
    const result = getFreeTierNote(
      "AWS::EC2::Instance",
      accountDate < "2025-07-15" ? accountDate : "2025-06-01",
    );
    expect(result).toEqual({
      type: "legacy_eligible",
      message: expect.stringContaining("750 hrs/month"),
    });
  });

  it("returns credits_apply for EC2::Instance with post-July-2025 account", () => {
    const result = getFreeTierNote("AWS::EC2::Instance", "2025-08-01");
    expect(result).toEqual({
      type: "credits_apply",
      message: "AWS credits may apply -- check your billing dashboard",
    });
  });

  it("returns credits_apply for EC2::Instance when account date is undefined", () => {
    const result = getFreeTierNote("AWS::EC2::Instance");
    expect(result).toEqual({
      type: "credits_apply",
      message:
        "Free tier eligibility unknown -- check your AWS billing dashboard",
    });
  });

  it("returns credits_apply for RDS::DBInstance with post-July-2025 account", () => {
    const result = getFreeTierNote("AWS::RDS::DBInstance", "2025-09-01");
    expect(result).toEqual({
      type: "credits_apply",
      message: "AWS credits may apply -- check your billing dashboard",
    });
  });

  it("returns null for S3::Bucket (usage-dependent, not in free tier maps)", () => {
    const result = getFreeTierNote("AWS::S3::Bucket");
    expect(result).toBeNull();
  });

  it("returns always_free for SQS::Queue (always free with limits)", () => {
    const result = getFreeTierNote("AWS::SQS::Queue");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("1M requests/month"),
    });
  });

  it("returns always_free for SNS::Topic (always free with limits)", () => {
    const result = getFreeTierNote("AWS::SNS::Topic");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("1M publishes/month"),
    });
  });

  it("returns always_free for EC2::VPC", () => {
    const result = getFreeTierNote("AWS::EC2::VPC");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for EC2::Subnet", () => {
    const result = getFreeTierNote("AWS::EC2::Subnet");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for EC2::SecurityGroup", () => {
    const result = getFreeTierNote("AWS::EC2::SecurityGroup");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for EC2::InternetGateway", () => {
    const result = getFreeTierNote("AWS::EC2::InternetGateway");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for EC2::RouteTable", () => {
    const result = getFreeTierNote("AWS::EC2::RouteTable");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for EC2::Route", () => {
    const result = getFreeTierNote("AWS::EC2::Route");
    expect(result).toEqual({
      type: "always_free",
      message: "Always free tier",
    });
  });

  it("returns always_free for ECS::Cluster", () => {
    const result = getFreeTierNote("AWS::ECS::Cluster");
    expect(result).toEqual({
      type: "always_free",
      message: expect.stringContaining("compute charged separately"),
    });
  });

  it("returns null for unknown resource types", () => {
    const result = getFreeTierNote("AWS::Unknown::Resource");
    expect(result).toBeNull();
  });

  it("returns null for legacy EC2 account that has expired the 12-month window", () => {
    // Account created well over 12 months ago (before cutoff)
    const result = getFreeTierNote("AWS::EC2::Instance", "2023-01-01");
    expect(result).toBeNull();
  });

  it("returns legacy_eligible for RDS with pre-July-2025 account within 12 months", () => {
    // Use a dynamic date that is within 12 months and before July 2025 cutoff
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const accountDate = sixMonthsAgo.toISOString().slice(0, 10);
    const result = getFreeTierNote(
      "AWS::RDS::DBInstance",
      accountDate < "2025-07-15" ? accountDate : "2025-06-01",
    );
    expect(result).toEqual({
      type: "legacy_eligible",
      message: expect.stringContaining("750 hrs/month"),
    });
  });
});

// ── loadAccountCreatedDate tests ─────────────────────────────────────────────

describe("loadAccountCreatedDate", () => {
  beforeEach(() => {
    _resetAccountDateCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetAccountDateCache();
  });

  it("returns date string from valid YAML config", () => {
    vi.mocked(readFileSync).mockReturnValue(
      "aws_account_created: '2024-06-15'\n",
    );

    const result = loadAccountCreatedDate();
    expect(result).toBe("2024-06-15");
  });

  it("returns undefined when file does not exist (ENOENT)", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const result = loadAccountCreatedDate();
    expect(result).toBeUndefined();
  });

  it("returns undefined when YAML has no aws_account_created field", () => {
    vi.mocked(readFileSync).mockReturnValue("region: eu-west-1\n");

    const result = loadAccountCreatedDate();
    expect(result).toBeUndefined();
  });

  it("returns undefined for corrupted YAML content", () => {
    vi.mocked(readFileSync).mockReturnValue(":::invalid yaml:::");

    const result = loadAccountCreatedDate();
    // Should not throw — returns undefined gracefully
    expect(result).toBeUndefined();
  });

  it("caches the result and does not re-read on second call", () => {
    vi.mocked(readFileSync).mockReturnValue(
      "aws_account_created: '2024-06-15'\n",
    );

    loadAccountCreatedDate();
    loadAccountCreatedDate();

    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("never throws even with unexpected errors", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("Unexpected permission denied");
    });

    expect(() => loadAccountCreatedDate()).not.toThrow();
    expect(loadAccountCreatedDate()).toBeUndefined();
  });
});
