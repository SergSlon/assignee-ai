import { describe, it, expect } from "vitest";
import {
  ec2InstancePlugin,
  classifyUserData,
  encodeUserData,
} from "./ec2-instance.js";

describe("ec2InstancePlugin", () => {
  it("has the correct resourceType", () => {
    expect(ec2InstancePlugin.resourceType).toBe("AWS::EC2::Instance");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(ec2InstancePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 5 (Tags moved to advancedFields)", () => {
    expect(ec2InstancePlugin.commonFields.length).toBe(5);
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
    expect(field?.name).toBe("InstanceType");
    expect(field?.question.type).toBe("categorySelect");
    expect(field?.question.initialValue).toBe("t3.micro");
    expect(field?.question.categories?.length).toBe(4);
    const allValues =
      field?.question.categories?.flatMap((c) =>
        c.options.map((o) => o.value),
      ) ?? [];
    expect(allValues.length).toBe(28);
    expect(allValues).toContain("t3.micro");
    expect(allValues).toContain("m5.large");
    expect(allValues).toContain("c5.large");
    expect(allValues).toContain("r5.large");
    expect(new Set(allValues).size).toBe(28);
  });

  it("ImageId is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "ImageId",
    );
    expect(field?.name).toBe("ImageId");
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-amis");
  });

  it("KeyName is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "KeyName",
    );
    expect(field?.name).toBe("KeyName");
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-key-pairs");
  });

  it("SecurityGroupIds is a multi field", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "SecurityGroupIds",
    );
    expect(field?.name).toBe("SecurityGroupIds");
    expect(field?.question.type).toBe("multi");
  });

  it("Tags field is in advancedFields with string type and toCfn transform", () => {
    const field = ec2InstancePlugin.advancedFields.find(
      (f) => f.name === "Tags",
    );
    expect(field?.name).toBe("Tags");
    expect(field?.question.type).toBe("string");
    expect(typeof field?.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = ec2InstancePlugin.advancedFields.find(
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

  it("defaults includes secure settings: IMDSv2 + hop limit, encrypted EBS, termination protection, EBS optimized, CPU credits standard", () => {
    // Epic 92 Wave 4.b (finding C-16): the facade seeds
    // CreditSpecification = { CpuCredits: "standard" } on top of the
    // inner plugin's defaults so the plan-row "CPU Credits" is never
    // empty. "standard" matches AWS's own default for burstable
    // (t3/t4g) types and is a no-op for non-burstable types at apply.
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
      CreditSpecification: { CpuCredits: "standard" },
    });
  });

  it("CPU Credits default (C-16): CreditSpecification seeded with CpuCredits=standard", () => {
    // Finding C-16 root cause: when the user didn't supply a
    // CreditSpecification, the plan-display row "CPU Credits" (from
    // utils/display-helpers/friendly-names.ts) rendered with an empty
    // value and looked broken. The facade now seeds the AWS-native
    // default so every plan row has a meaningful value.
    expect(ec2InstancePlugin.defaults["CreditSpecification"]).toEqual({
      CpuCredits: "standard",
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

  describe("UserData base64/plaintext detection (Item 3a)", () => {
    const userDataField = ec2InstancePlugin.advancedFields.find(
      (f) => f.name === "UserData",
    )!;

    describe("classifyUserData", () => {
      it("classifies bash shebang as plaintext", () => {
        expect(classifyUserData("#!/bin/bash\necho hello")).toBe("plaintext");
      });

      it("classifies sh shebang as plaintext", () => {
        expect(classifyUserData("#!/bin/sh\nexit 0")).toBe("plaintext");
      });

      it("classifies cloud-init YAML as plaintext", () => {
        expect(classifyUserData("#cloud-config\nruncmd:\n  - echo hello")).toBe(
          "plaintext",
        );
      });

      it("classifies multipart MIME as plaintext", () => {
        expect(
          classifyUserData(
            'Content-Type: multipart/mixed; boundary="//"\n\n--//\n',
          ),
        ).toBe("plaintext");
      });

      it("classifies valid base64 (binary blob) as base64", () => {
        expect(classifyUserData("aGVsbG8gd29ybGQ=")).toBe("base64");
      });

      it("classifies double-base64 of a shell script as double-base64", () => {
        const script = "#!/bin/bash\necho hello";
        const encoded = Buffer.from(script, "utf8").toString("base64");
        expect(classifyUserData(encoded)).toBe("double-base64");
      });

      it("classifies double-base64 of cloud-init as double-base64", () => {
        const script = "#cloud-config\nruncmd:\n  - echo hi\n";
        const encoded = Buffer.from(script, "utf8").toString("base64");
        expect(classifyUserData(encoded)).toBe("double-base64");
      });

      it("classifies empty string as plaintext", () => {
        expect(classifyUserData("")).toBe("plaintext");
      });

      it("classifies whitespace-only string as plaintext", () => {
        expect(classifyUserData("   \n\t  ")).toBe("plaintext");
      });

      it("classifies UTF-8 non-ASCII plaintext as plaintext", () => {
        expect(classifyUserData("こんにちは世界")).toBe("plaintext");
      });

      it("classifies base64 with newlines as base64 (stripped)", () => {
        const encoded = Buffer.from("binary blob content", "utf8").toString(
          "base64",
        );
        const multiline = encoded.slice(0, 8) + "\n" + encoded.slice(8);
        expect(classifyUserData(multiline)).toBe("base64");
      });

      it("classifies non-multiple-of-4 length as plaintext", () => {
        expect(classifyUserData("abcde")).toBe("plaintext");
      });
    });

    describe("encodeUserData", () => {
      it("encodes bash shebang plaintext", () => {
        const input = "#!/bin/bash\necho hello";
        expect(encodeUserData(input)).toBe(
          Buffer.from(input, "utf8").toString("base64"),
        );
      });

      it("encodes cloud-init plaintext", () => {
        const input = "#cloud-config\nruncmd:\n  - echo hi";
        expect(encodeUserData(input)).toBe(
          Buffer.from(input, "utf8").toString("base64"),
        );
      });

      it("passes through valid base64 blob unchanged", () => {
        const encoded = "aGVsbG8gd29ybGQ=";
        expect(encodeUserData(encoded)).toBe(encoded);
      });

      it("strips whitespace from base64 blob", () => {
        const encoded = "aGVsbG8gd29ybGQ=";
        const multiline = "aGVsbG8g\nd29ybGQ=";
        expect(encodeUserData(multiline)).toBe(encoded);
      });

      it("throws with actionable hint on double-base64", () => {
        const script = "#!/bin/bash\necho hi";
        const encoded = Buffer.from(script, "utf8").toString("base64");
        expect(() => encodeUserData(encoded)).toThrow(
          /already base64-encoded/i,
        );
        expect(() => encodeUserData(encoded)).toThrow(/raw script text/i);
      });

      it("encodes UTF-8 non-ASCII plaintext", () => {
        const input = "こんにちは";
        expect(encodeUserData(input)).toBe(
          Buffer.from(input, "utf8").toString("base64"),
        );
      });
    });

    describe("UserData field wiring", () => {
      it("validate rejects double-base64 with hint", () => {
        const script = "#!/bin/bash\necho hi";
        const encoded = Buffer.from(script, "utf8").toString("base64");
        const err = userDataField.question.validate!(encoded);
        expect(typeof err).toBe("string");
        expect(err as string).toMatch(/already base64-encoded/i);
      });

      it("validate accepts plaintext shebang", () => {
        expect(
          userDataField.question.validate!("#!/bin/bash\necho hi"),
        ).toBeUndefined();
      });

      it("validate still enforces 16 KB cap", () => {
        const big = "x".repeat(16385);
        expect(userDataField.question.validate!(big)).toMatch(/16 KB/);
      });

      it("toCfn encodes plaintext shebang", () => {
        const input = "#!/bin/bash\necho hi";
        expect(userDataField.toCfn!(input)).toBe(
          Buffer.from(input, "utf8").toString("base64"),
        );
      });

      it("toCfn passes through valid base64 blob", () => {
        const encoded = "aGVsbG8gd29ybGQ=";
        expect(userDataField.toCfn!(encoded)).toBe(encoded);
      });

      it("toCfn returns undefined for empty", () => {
        expect(userDataField.toCfn!("")).toBeUndefined();
        expect(userDataField.toCfn!(undefined)).toBeUndefined();
      });

      it("toCfn throws on double-base64 (safety net for LLM/--set path)", () => {
        const script = "#cloud-config\nruncmd:\n  - echo hi";
        const encoded = Buffer.from(script, "utf8").toString("base64");
        expect(() => userDataField.toCfn!(encoded)).toThrow(
          /already base64-encoded/i,
        );
      });
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
