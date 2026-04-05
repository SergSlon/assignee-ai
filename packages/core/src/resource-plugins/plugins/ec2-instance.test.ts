import { describe, it, expect } from "vitest";
import { ec2InstancePlugin } from "./ec2-instance.js";

describe("ec2InstancePlugin", () => {
  it("has the correct resourceType", () => {
    expect(ec2InstancePlugin.resourceType).toBe("AWS::EC2::Instance");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(ec2InstancePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(ec2InstancePlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set([
      "boolean",
      "enum",
      "string",
      "multi",
      "categorySelect",
    ]);
    for (const field of ec2InstancePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("InstanceType is categorySelect with t3.micro default and categories", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "InstanceType",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("categorySelect");
    expect(field?.question.initialValue).toBe("t3.micro");
    expect(field?.question.categories?.length).toBe(4);
    // Verify all 28 instance types are present across categories
    const allValues =
      field?.question.categories?.flatMap((c) =>
        c.options.map((o) => o.value),
      ) ?? [];
    expect(allValues.length).toBe(28);
    expect(allValues).toContain("t3.micro");
    expect(allValues).toContain("m5.large");
    expect(allValues).toContain("c5.large");
    expect(allValues).toContain("r5.large");
    // No duplicate values
    expect(new Set(allValues).size).toBe(28);
  });

  it("ImageId is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "ImageId",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-amis");
  });

  it("KeyName is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "KeyName",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-key-pairs");
  });

  it("SecurityGroupIds is a multi field", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "SecurityGroupIds",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("Tags field is string type with toCfn transform", () => {
    const field = ec2InstancePlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
    expect(field?.toCfn).toBeDefined();
  });

  describe("Tags toCfn transform", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("converts comma-separated Key:Value pairs to CFN array", () => {
      expect(field.toCfn!("env:production, team:backend")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(field.toCfn!("   ")).toBeUndefined();
    });

    it("handles single tag", () => {
      expect(field.toCfn!("env:prod")).toEqual([{ Key: "env", Value: "prod" }]);
    });

    it("handles values containing colons (e.g., ARN)", () => {
      expect(field.toCfn!("role:arn:aws:iam::123:role/my-role")).toEqual([
        { Key: "role", Value: "arn:aws:iam::123:role/my-role" },
      ]);
    });

    it("trims whitespace from keys and values", () => {
      expect(field.toCfn!("  env : production , team : backend  ")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for non-string input", () => {
      expect(field.toCfn!(42)).toBeUndefined();
    });
  });

  it("advancedFields contains IamInstanceProfile and UserData", () => {
    const names = ec2InstancePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("IamInstanceProfile");
    expect(names).toContain("UserData");
  });

  it("defaults includes secure settings: IMDSv2 + hop limit, encrypted EBS, termination protection, EBS optimized", () => {
    expect(ec2InstancePlugin.defaults).toEqual({
      MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 1 },
      DisableApiTermination: true,
      EbsOptimized: true,
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/xvda",
          Ebs: { Encrypted: true, VolumeType: "gp3" },
        },
      ],
    });
  });

  describe("EbsVolumeSize validation", () => {
    const field = ec2InstancePlugin.advancedFields.find(
      (f) => f.name === "EbsVolumeSize",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid volume size", () => {
      expect(field.question.validate?.("8")).toBeUndefined();
      expect(field.question.validate?.("100")).toBeUndefined();
      expect(field.question.validate?.("16384")).toBeUndefined();
    });

    it("rejects value below 1", () => {
      expect(field.question.validate?.("0")).toBeDefined();
    });

    it("rejects value above 16384", () => {
      expect(field.question.validate?.("16385")).toBeDefined();
    });

    it("rejects non-numeric value", () => {
      expect(field.question.validate?.("abc")).toBeDefined();
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      expect(ec2InstancePlugin.configHints).toBeDefined();
      expect(ec2InstancePlugin.configHints!.length).toBeGreaterThan(0);
    });

    it("includes guidance about ImageId (AMI)", () => {
      const hints = ec2InstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/ImageId/i);
      expect(hints).toMatch(/AMI/i);
    });

    it("includes guidance about IMDSv2", () => {
      const hints = ec2InstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/IMDSv2/i);
      expect(hints).toMatch(/HttpTokens/i);
    });

    it("includes guidance about EBS encryption", () => {
      const hints = ec2InstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/Encrypted/i);
      expect(hints).toMatch(/gp3/i);
    });

    it("includes guidance about KeyName and SecurityGroupIds omission", () => {
      const hints = ec2InstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/KeyName/i);
      expect(hints).toMatch(/SecurityGroupIds/i);
      expect(hints).toMatch(/OMIT/i);
    });

    it("includes guidance about CreditSpecification for burstable types", () => {
      const hints = ec2InstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/CreditSpecification/i);
      expect(hints).toMatch(/burstable/i);
    });
  });
});
