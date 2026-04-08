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
    // Wave 16: strengthened — assert by name + question type instead
    // of bare existence (matches the strengthening pattern across all
    // plugin tests in this wave).
    expect(field?.name).toBe("InstanceType");
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
    // Wave 16: strengthened.
    expect(field?.name).toBe("ImageId");
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-amis");
  });

  it("KeyName is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "KeyName",
    );
    // Wave 16: strengthened.
    expect(field?.name).toBe("KeyName");
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-key-pairs");
  });

  it("SecurityGroupIds is a multi field", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "SecurityGroupIds",
    );
    // Wave 16: strengthened.
    expect(field?.name).toBe("SecurityGroupIds");
    expect(field?.question.type).toBe("multi");
  });

  it("Tags field is string type with toCfn transform", () => {
    const field = ec2InstancePlugin.commonFields.find((f) => f.name === "Tags");
    // Wave 16: strengthened — assert by name + that toCfn is callable.
    expect(field?.name).toBe("Tags");
    expect(field?.question.type).toBe("string");
    expect(typeof field?.toCfn).toBe("function");
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

    // Wave 16: strengthened — validators must return a non-empty STRING
    // error message, not just any non-undefined value (e.g. `0`,
    // `false`, `""`). Same pattern as the lambda-function and
    // s3-bucket plugin tests.
    it("rejects value below 1", () => {
      const err = field.question.validate?.("0");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects value above 16384", () => {
      const err = field.question.validate?.("16385");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects non-numeric value", () => {
      const err = field.question.validate?.("abc");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      // Wave 16: dropped redundant `toBeDefined()` — `Array.isArray`
      // catches null/undefined AND non-array shapes.
      expect(Array.isArray(ec2InstancePlugin.configHints)).toBe(true);
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

  describe("companionResources", () => {
    it("returns SecurityGroup with SSH port when KeyName is set", () => {
      const companions = ec2InstancePlugin.companionResources!({
        KeyName: "my-key",
        InstanceType: "t3.micro",
      });
      expect(companions).toHaveLength(1);
      expect(companions[0]!.type).toBe("AWS::EC2::SecurityGroup");
      const ingress = companions[0]!.properties[
        "SecurityGroupIngress"
      ] as Array<{ FromPort?: number }>;
      expect(ingress.some((r) => r.FromPort === 22)).toBe(true);
    });

    it("returns SecurityGroup with HTTP/HTTPS when public IP set", () => {
      const companions = ec2InstancePlugin.companionResources!({
        AssociatePublicIpAddress: true,
        InstanceType: "t3.small",
      });
      expect(companions).toHaveLength(1);
      const ingress = companions[0]!.properties[
        "SecurityGroupIngress"
      ] as Array<{ FromPort?: number }>;
      expect(ingress.some((r) => r.FromPort === 80)).toBe(true);
      expect(ingress.some((r) => r.FromPort === 443)).toBe(true);
    });

    it("returns empty when SecurityGroupIds already specified", () => {
      const companions = ec2InstancePlugin.companionResources!({
        SecurityGroupIds: ["sg-123abc"],
        KeyName: "my-key",
      });
      expect(companions).toHaveLength(0);
    });

    it("returns empty when no SSH or public IP signals", () => {
      const companions = ec2InstancePlugin.companionResources!({
        InstanceType: "t3.micro",
      });
      expect(companions).toHaveLength(0);
    });
  });
});
