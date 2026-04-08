import { describe, it, expect } from "vitest";
import { efsMountTargetPlugin } from "./efs-mount-target.js";
import { CfnKey } from "../../config/cfn-keys.js";

describe("efsMountTargetPlugin", () => {
  it("has the correct resource type", () => {
    expect(efsMountTargetPlugin.resourceType).toBe("AWS::EFS::MountTarget");
  });

  it("has ≤10 common fields", () => {
    expect(efsMountTargetPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("marks FileSystemId, SubnetId, and SecurityGroups as required", () => {
    const ids = efsMountTargetPlugin.commonFields
      .filter((f) => f.required === true)
      .map((f) => f.name);
    expect(ids).toContain("FileSystemId");
    expect(ids).toContain(CfnKey.SUBNET_ID);
    expect(ids).toContain("SecurityGroups");
  });

  describe("FileSystemId validation", () => {
    const field = efsMountTargetPlugin.commonFields.find(
      (f) => f.name === "FileSystemId",
    )!;
    const validate = field.question.validate!;

    function expectStringError(value: unknown): void {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }

    it("rejects empty", () => {
      expectStringError(validate(""));
    });

    it("accepts a valid fs- ID", () => {
      expect(validate("fs-0123456789abcdef0")).toBeUndefined();
    });

    it("rejects a subnet-shaped ID (wrong resource)", () => {
      expectStringError(validate("subnet-0123456789abcdef0"));
    });

    it("rejects a bare UUID", () => {
      expectStringError(validate("01234567-89ab-cdef-0123-456789abcdef"));
    });
  });

  describe("SubnetId validation", () => {
    const field = efsMountTargetPlugin.commonFields.find(
      (f) => f.name === CfnKey.SUBNET_ID,
    )!;
    const validate = field.question.validate!;

    it("rejects empty", () => {
      expect(typeof validate("")).toBe("string");
    });

    it("accepts a valid subnet- ID", () => {
      expect(validate("subnet-0123456789abcdef0")).toBeUndefined();
    });

    it("rejects an fs- ID (wrong resource)", () => {
      expect(typeof validate("fs-0123456789abcdef0")).toBe("string");
    });
  });

  describe("SecurityGroups field", () => {
    const field = efsMountTargetPlugin.commonFields.find(
      (f) => f.name === "SecurityGroups",
    )!;
    const validate = field.question.validate!;
    const toCfn = field.toCfn!;

    it("rejects empty", () => {
      expect(typeof validate("")).toBe("string");
    });

    it("accepts a single sg- ID", () => {
      expect(validate("sg-0123456789abcdef0")).toBeUndefined();
    });

    it("accepts multiple comma-separated sg- IDs", () => {
      expect(
        validate("sg-0123456789abcdef0, sg-0abcdef0123456789"),
      ).toBeUndefined();
    });

    it("rejects a malformed ID mixed with a valid one", () => {
      expect(typeof validate("sg-0123, not-a-sg")).toBe("string");
    });

    it("toCfn splits comma-separated input into a trimmed string array", () => {
      const result = toCfn("sg-0123456789abcdef0, sg-0abcdef0123456789");
      expect(result).toEqual(["sg-0123456789abcdef0", "sg-0abcdef0123456789"]);
    });

    it("toCfn returns undefined for empty input (omits the field)", () => {
      expect(toCfn("")).toBeUndefined();
      expect(toCfn(undefined)).toBeUndefined();
    });

    it("toCfn drops empty segments from trailing commas", () => {
      const result = toCfn("sg-0123456789abcdef0,,,");
      expect(result).toEqual(["sg-0123456789abcdef0"]);
    });
  });

  describe("advanced IpAddress field", () => {
    const field = efsMountTargetPlugin.advancedFields.find(
      (f) => f.name === "IpAddress",
    )!;
    const validate = field.question.validate!;

    it("accepts empty (AWS auto-assigns)", () => {
      expect(validate("")).toBeUndefined();
    });

    it("accepts a valid IPv4 address", () => {
      expect(validate("10.0.1.42")).toBeUndefined();
    });

    it("rejects an IPv6 address", () => {
      expect(typeof validate("::1")).toBe("string");
    });

    it("rejects garbage", () => {
      expect(typeof validate("not-an-ip")).toBe("string");
    });
  });

  it("configHints document the FileSystemTags / createOnly / TCP 2049 gotchas", () => {
    const joined = (efsMountTargetPlugin.configHints ?? []).join(" ");
    expect(joined).toMatch(/FileSystemTags|tags/i);
    expect(joined).toMatch(/createOnly/i);
    expect(joined).toMatch(/2049/);
  });

  it("has no defaults — all three required fields must come from the user", () => {
    expect(efsMountTargetPlugin.defaults).toEqual({});
  });
});
