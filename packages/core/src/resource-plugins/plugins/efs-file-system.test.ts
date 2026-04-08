import { describe, it, expect } from "vitest";
import { efsFileSystemPlugin } from "./efs-file-system.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";

describe("efsFileSystemPlugin", () => {
  it("has the correct resource type", () => {
    expect(efsFileSystemPlugin.resourceType).toBe("AWS::EFS::FileSystem");
  });

  it("has ≤10 common fields", () => {
    expect(efsFileSystemPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("marks Name as required (promoted into FileSystemTags)", () => {
    const field = efsFileSystemPlugin.commonFields.find(
      (f) => f.name === CfnKey.NAME,
    );
    expect(field?.required).toBe(true);
  });

  it("defaults Encrypted to true (BP-EFS-001 compliant by default)", () => {
    expect(efsFileSystemPlugin.defaults[CfnKey.ENCRYPTED]).toBe(true);
  });

  it("defaults PerformanceMode to generalPurpose", () => {
    expect(efsFileSystemPlugin.defaults[CfnKey.PERFORMANCE_MODE]).toBe(
      AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
    );
  });

  it("defaults ThroughputMode to elastic (modern pay-per-use default)", () => {
    expect(efsFileSystemPlugin.defaults[CfnKey.THROUGHPUT_MODE]).toBe(
      AwsDefault.EFS_THROUGHPUT_ELASTIC,
    );
  });

  it("defaults BackupPolicy.Status to ENABLED (BP-EFS-002 compliant by default)", () => {
    expect(efsFileSystemPlugin.defaults[CfnKey.BACKUP_POLICY]).toEqual({
      [CfnKey.BACKUP_POLICY_STATUS]: AwsDefault.EFS_BACKUP_ENABLED,
    });
  });

  describe("Name validation", () => {
    const field = efsFileSystemPlugin.commonFields.find(
      (f) => f.name === CfnKey.NAME,
    )!;
    const validate = field.question.validate!;

    function expectStringError(value: unknown): void {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }

    it("rejects empty value", () => {
      expectStringError(validate(""));
    });

    it("accepts a valid human-friendly name", () => {
      expect(validate("my-shared-volume")).toBeUndefined();
    });

    it("accepts tag-compatible characters (_.=@-)", () => {
      expect(validate("prod_vol.v2=primary")).toBeUndefined();
    });

    it("rejects names with shell metacharacters", () => {
      expectStringError(validate("bad`name"));
      expectStringError(validate("bad;name"));
      expectStringError(validate("bad$name"));
    });

    it("rejects names longer than 256 characters", () => {
      expectStringError(validate("x".repeat(257)));
    });
  });

  describe("Name toCfn — promotes into FileSystemTags", () => {
    const field = efsFileSystemPlugin.commonFields.find(
      (f) => f.name === CfnKey.NAME,
    )!;
    const toCfn = field.toCfn!;

    it("returns a single-element Name tag array for a non-empty string", () => {
      const result = toCfn("my-shared-volume");
      expect(result).toEqual([{ Key: "Name", Value: "my-shared-volume" }]);
    });

    it("returns undefined for an empty string", () => {
      expect(toCfn("")).toBeUndefined();
    });

    it("trims whitespace before tagging", () => {
      expect(toCfn("  my-vol  ")).toEqual([{ Key: "Name", Value: "my-vol" }]);
    });
  });

  describe("PerformanceMode enum", () => {
    const field = efsFileSystemPlugin.commonFields.find(
      (f) => f.name === CfnKey.PERFORMANCE_MODE,
    )!;

    it("offers exactly the two CCAPI-supported modes", () => {
      const values = field.question.options!.map((o) => o.value);
      expect(values).toEqual([
        AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
        AwsDefault.EFS_PERFORMANCE_MAX_IO,
      ]);
    });

    it("marks generalPurpose as recommended", () => {
      const gp = field.question.options!.find(
        (o) => o.value === AwsDefault.EFS_PERFORMANCE_GENERAL_PURPOSE,
      );
      expect(gp?.recommended).toBe(true);
    });
  });

  describe("ThroughputMode enum", () => {
    const field = efsFileSystemPlugin.commonFields.find(
      (f) => f.name === CfnKey.THROUGHPUT_MODE,
    )!;

    it("offers all three CCAPI-supported throughput modes", () => {
      const values = field.question.options!.map((o) => o.value).sort();
      expect(values).toEqual(
        [
          AwsDefault.EFS_THROUGHPUT_BURSTING,
          AwsDefault.EFS_THROUGHPUT_ELASTIC,
          AwsDefault.EFS_THROUGHPUT_PROVISIONED,
        ].sort(),
      );
    });

    it("marks elastic as the recommended modern default", () => {
      const elastic = field.question.options!.find(
        (o) => o.value === AwsDefault.EFS_THROUGHPUT_ELASTIC,
      );
      expect(elastic?.recommended).toBe(true);
    });
  });

  describe("ProvisionedThroughputInMibps advanced field", () => {
    const field = efsFileSystemPlugin.advancedFields.find(
      (f) => f.name === CfnKey.PROVISIONED_THROUGHPUT_IN_MIBPS,
    )!;
    const validate = field.question.validate!;
    const toCfn = field.toCfn!;

    it("is only shown when ThroughputMode=provisioned", () => {
      expect(field.question.showIf).toEqual({
        field: CfnKey.THROUGHPUT_MODE,
        value: AwsDefault.EFS_THROUGHPUT_PROVISIONED,
      });
    });

    it("rejects empty value", () => {
      expect(typeof validate("")).toBe("string");
    });

    it("rejects 0 (below minimum)", () => {
      expect(typeof validate("0")).toBe("string");
    });

    it("rejects values above 3072 MiB/s (AWS max)", () => {
      expect(typeof validate("3073")).toBe("string");
    });

    it("accepts boundary values 1 and 3072", () => {
      expect(validate("1")).toBeUndefined();
      expect(validate("3072")).toBeUndefined();
    });

    it("converts answer to a number for CloudFormation", () => {
      expect(toCfn("128")).toBe(128);
    });

    it("returns undefined for empty answer (omits the property)", () => {
      expect(toCfn("")).toBeUndefined();
      expect(toCfn(undefined)).toBeUndefined();
    });
  });

  describe("BackupPolicy toCfn — nested Status object shape", () => {
    const field = efsFileSystemPlugin.advancedFields.find(
      (f) => f.name === CfnKey.BACKUP_POLICY,
    )!;
    const toCfn = field.toCfn!;

    it("emits { Status: ENABLED } when the user enables backups", () => {
      expect(toCfn(true)).toEqual({
        [CfnKey.BACKUP_POLICY_STATUS]: AwsDefault.EFS_BACKUP_ENABLED,
      });
    });

    it("emits { Status: DISABLED } when the user opts out", () => {
      expect(toCfn(false)).toEqual({
        [CfnKey.BACKUP_POLICY_STATUS]: AwsDefault.EFS_BACKUP_DISABLED,
      });
    });
  });

  describe("KmsKeyId advanced field", () => {
    const field = efsFileSystemPlugin.advancedFields.find(
      (f) => f.name === CfnKey.KMS_KEY_ID,
    )!;
    const validate = field.question.validate!;

    it("is only shown when Encrypted=true", () => {
      expect(field.question.showIf).toEqual({
        field: CfnKey.ENCRYPTED,
        value: true,
      });
    });

    it("accepts empty (falls back to AWS-managed key)", () => {
      expect(validate("")).toBeUndefined();
    });

    it("accepts a KMS key ARN", () => {
      expect(
        validate(
          "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
        ),
      ).toBeUndefined();
    });

    it("accepts a KMS alias", () => {
      expect(validate("alias/my-efs-key")).toBeUndefined();
    });

    it("accepts a 36-char raw key ID", () => {
      expect(validate("12345678-1234-1234-1234-123456789012")).toBeUndefined();
    });

    it("rejects garbage", () => {
      expect(typeof validate("not-a-key")).toBe("string");
    });
  });

  describe("AvailabilityZoneName validation (One Zone mode)", () => {
    const field = efsFileSystemPlugin.advancedFields.find(
      (f) => f.name === CfnKey.AVAILABILITY_ZONE_NAME,
    )!;
    const validate = field.question.validate!;

    it("accepts empty (defaults to Regional)", () => {
      expect(validate("")).toBeUndefined();
    });

    it("accepts a valid AZ like us-east-1a", () => {
      expect(validate("us-east-1a")).toBeUndefined();
    });

    it("accepts a GovCloud AZ", () => {
      expect(validate("us-gov-west-1a")).toBeUndefined();
    });

    it("rejects a region (not an AZ)", () => {
      expect(typeof validate("us-east-1")).toBe("string");
    });
  });

  it("configHints captures the FileSystemTags vs Tags gotcha", () => {
    const joined = (efsFileSystemPlugin.configHints ?? []).join(" ");
    expect(joined).toMatch(/FileSystemTags/);
    expect(joined).toMatch(/BackupPolicy/);
    expect(joined).toMatch(/createOnly/i);
  });
});
