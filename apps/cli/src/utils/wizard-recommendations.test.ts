import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateWizardRecommendations,
  displayRecommendations,
  RECOMMENDATION_RULES,
  type WizardRecommendation,
} from "./wizard-recommendations.js";

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({
  note: vi.fn(),
}));

// Mock chalk — return plain strings with markers for assertion
vi.mock("chalk", () => ({
  default: {
    yellow: (s: string) => `[yellow]${s}[/yellow]`,
    blue: (s: string) => `[blue]${s}[/blue]`,
  },
}));

import * as clack from "@clack/prompts";

// ── evaluateWizardRecommendations ────────────────────────────────────────────

describe("evaluateWizardRecommendations", () => {
  // ── EC2 key pair rule ────────────────────────────────────────────────────

  describe("ec2-no-key-pair", () => {
    it("triggers when KeyName is missing", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro" },
        "deploy a dev instance",
        "AWS::EC2::Instance",
      );
      const match = result.find((r) => r.id === "ec2-no-key-pair");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("info");
    });

    it("triggers when KeyName is empty string", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro", KeyName: "" },
        "deploy a dev instance",
        "AWS::EC2::Instance",
      );
      expect(result.find((r) => r.id === "ec2-no-key-pair")).toBeDefined();
    });

    it("triggers when KeyName is 'none'", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro", KeyName: "none" },
        "deploy a dev instance",
        "AWS::EC2::Instance",
      );
      expect(result.find((r) => r.id === "ec2-no-key-pair")).toBeDefined();
    });

    it("does NOT trigger when KeyName is set", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro", KeyName: "my-key" },
        "deploy a dev instance",
        "AWS::EC2::Instance",
      );
      expect(result.find((r) => r.id === "ec2-no-key-pair")).toBeUndefined();
    });
  });

  // ── EC2 undersized production rule ───────────────────────────────────────

  describe("ec2-undersized-prod", () => {
    it("triggers for t3.micro + production intent", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro", KeyName: "my-key" },
        "deploy a production EC2 instance",
        "AWS::EC2::Instance",
      );
      const match = result.find((r) => r.id === "ec2-undersized-prod");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warn");
    });

    it("triggers for t3.nano + prod intent", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.nano", KeyName: "my-key" },
        "create a prod server",
        "AWS::EC2::Instance",
      );
      expect(result.find((r) => r.id === "ec2-undersized-prod")).toBeDefined();
    });

    it("does NOT trigger for t3.micro + dev intent", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro", KeyName: "my-key" },
        "deploy a dev instance",
        "AWS::EC2::Instance",
      );
      expect(
        result.find((r) => r.id === "ec2-undersized-prod"),
      ).toBeUndefined();
    });

    it("does NOT trigger for t3.large + production intent", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.large", KeyName: "my-key" },
        "deploy a production EC2 instance",
        "AWS::EC2::Instance",
      );
      expect(
        result.find((r) => r.id === "ec2-undersized-prod"),
      ).toBeUndefined();
    });
  });

  // ── S3 versioning rule ───────────────────────────────────────────────────

  describe("s3-no-versioning", () => {
    it("triggers when VersioningConfiguration is missing", () => {
      const result = evaluateWizardRecommendations(
        { BucketName: "my-bucket" },
        "create a bucket",
        "AWS::S3::Bucket",
      );
      const match = result.find((r) => r.id === "s3-no-versioning");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("info");
    });

    it("triggers when VersioningConfiguration is false", () => {
      const result = evaluateWizardRecommendations(
        { BucketName: "my-bucket", VersioningConfiguration: false },
        "create a bucket",
        "AWS::S3::Bucket",
      );
      expect(result.find((r) => r.id === "s3-no-versioning")).toBeDefined();
    });

    it("triggers when VersioningConfiguration Status is not Enabled", () => {
      const result = evaluateWizardRecommendations(
        {
          BucketName: "my-bucket",
          VersioningConfiguration: { Status: "Suspended" },
        },
        "create a bucket",
        "AWS::S3::Bucket",
      );
      expect(result.find((r) => r.id === "s3-no-versioning")).toBeDefined();
    });

    it("does NOT trigger when VersioningConfiguration is true", () => {
      const result = evaluateWizardRecommendations(
        { BucketName: "my-bucket", VersioningConfiguration: true },
        "create a bucket",
        "AWS::S3::Bucket",
      );
      expect(result.find((r) => r.id === "s3-no-versioning")).toBeUndefined();
    });

    it("does NOT trigger when VersioningConfiguration Status is Enabled", () => {
      const result = evaluateWizardRecommendations(
        {
          BucketName: "my-bucket",
          VersioningConfiguration: { Status: "Enabled" },
        },
        "create a bucket",
        "AWS::S3::Bucket",
      );
      expect(result.find((r) => r.id === "s3-no-versioning")).toBeUndefined();
    });
  });

  // ── RDS Multi-AZ rule ────────────────────────────────────────────────────

  describe("rds-no-multi-az-prod", () => {
    it("triggers for non-MultiAZ + prod intent", () => {
      const result = evaluateWizardRecommendations(
        { DBInstanceClass: "db.t3.micro", MultiAZ: false },
        "create a prod database",
        "AWS::RDS::DBInstance",
      );
      const match = result.find((r) => r.id === "rds-no-multi-az-prod");
      expect(match).toBeDefined();
      expect(match!.severity).toBe("warn");
    });

    it("triggers when MultiAZ is undefined + production intent", () => {
      const result = evaluateWizardRecommendations(
        { DBInstanceClass: "db.t3.micro" },
        "deploy production database",
        "AWS::RDS::DBInstance",
      );
      expect(result.find((r) => r.id === "rds-no-multi-az-prod")).toBeDefined();
    });

    it("does NOT trigger for MultiAZ=true + prod intent", () => {
      const result = evaluateWizardRecommendations(
        { DBInstanceClass: "db.t3.micro", MultiAZ: true },
        "create a prod database",
        "AWS::RDS::DBInstance",
      );
      expect(
        result.find((r) => r.id === "rds-no-multi-az-prod"),
      ).toBeUndefined();
    });

    it("does NOT trigger for non-MultiAZ + dev intent", () => {
      const result = evaluateWizardRecommendations(
        { DBInstanceClass: "db.t3.micro", MultiAZ: false },
        "create a dev database",
        "AWS::RDS::DBInstance",
      );
      expect(
        result.find((r) => r.id === "rds-no-multi-az-prod"),
      ).toBeUndefined();
    });
  });

  // ── Cross-resource filtering ─────────────────────────────────────────────

  describe("resource type filtering", () => {
    it("S3 rules do not fire for EC2 resource type", () => {
      const result = evaluateWizardRecommendations(
        { BucketName: "my-bucket" },
        "create a bucket",
        "AWS::EC2::Instance",
      );
      expect(result.find((r) => r.id === "s3-no-versioning")).toBeUndefined();
    });

    it("EC2 rules do not fire for S3 resource type", () => {
      const result = evaluateWizardRecommendations(
        { InstanceType: "t3.micro" },
        "deploy a production instance",
        "AWS::S3::Bucket",
      );
      expect(
        result.find((r) => r.id === "ec2-undersized-prod"),
      ).toBeUndefined();
      expect(result.find((r) => r.id === "ec2-no-key-pair")).toBeUndefined();
    });

    it("RDS rules do not fire for EC2 resource type", () => {
      const result = evaluateWizardRecommendations(
        { MultiAZ: false },
        "deploy production",
        "AWS::EC2::Instance",
      );
      expect(
        result.find((r) => r.id === "rds-no-multi-az-prod"),
      ).toBeUndefined();
    });

    it("returns empty array for unsupported resource type", () => {
      const result = evaluateWizardRecommendations(
        {},
        "deploy something",
        "AWS::Lambda::Function",
      );
      expect(result).toEqual([]);
    });
  });
});

// ── displayRecommendations ───────────────────────────────────────────────────

describe("displayRecommendations", () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure TTY for display tests
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("produces no clack output for empty array", () => {
    displayRecommendations([]);
    expect(clack.note).not.toHaveBeenCalled();
  });

  it("skips display in non-TTY mode", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
    const recs: WizardRecommendation[] = [
      { id: "test", severity: "info", message: "test message" },
    ];
    displayRecommendations(recs);
    expect(clack.note).not.toHaveBeenCalled();
  });

  it("renders warn with yellow prefix and info with blue prefix", () => {
    const recs: WizardRecommendation[] = [
      { id: "info-rec", severity: "info", message: "info message" },
      { id: "warn-rec", severity: "warn", message: "warn message" },
    ];
    displayRecommendations(recs);
    expect(clack.note).toHaveBeenCalledTimes(2);

    // WARN should come first (sorted)
    const calls = (clack.note as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toContain("[yellow]");
    expect(calls[0]![1]).toContain("Warning");
    expect(calls[0]![0]).toBe("warn message");

    expect(calls[1]![1]).toContain("[blue]");
    expect(calls[1]![1]).toContain("Suggestion");
    expect(calls[1]![0]).toBe("info message");
  });

  it("orders WARN before INFO in output", () => {
    const recs: WizardRecommendation[] = [
      { id: "a-info", severity: "info", message: "first info" },
      { id: "b-warn", severity: "warn", message: "first warn" },
      { id: "c-info", severity: "info", message: "second info" },
    ];
    displayRecommendations(recs);
    const calls = (clack.note as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toBe("first warn");
    expect(calls[1]![0]).toBe("first info");
    expect(calls[2]![0]).toBe("second info");
  });
});
