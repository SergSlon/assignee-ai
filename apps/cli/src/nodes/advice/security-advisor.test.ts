import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import { securityPosture } from "./security-advisor.js";

describe("securityPosture", () => {
  describe("EC2", () => {
    it("flags missing IMDSv2", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
        ImageId: "ami-0c55b159cbfafe1f0",
      });
      expect(hints.some((h) => h.includes("IMDSv2 not enforced"))).toBe(true);
    });

    it("confirms IMDSv2 when enforced", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
        MetadataOptions: { HttpTokens: "required" },
      });
      expect(hints.some((h) => h.includes("IMDSv2 enforced"))).toBe(true);
    });

    it("flags unencrypted EBS", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
        MetadataOptions: { HttpTokens: "required" },
        BlockDeviceMappings: [
          { DeviceName: "/dev/xvda", Ebs: { VolumeType: "gp3" } },
        ],
      });
      expect(hints.some((h) => h.includes("EBS volume is unencrypted"))).toBe(
        true,
      );
    });

    it("does not flag encrypted EBS", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
        MetadataOptions: { HttpTokens: "required" },
        BlockDeviceMappings: [
          {
            DeviceName: "/dev/xvda",
            Ebs: { Encrypted: true, VolumeType: "gp3" },
          },
        ],
      });
      expect(hints.some((h) => h.includes("unencrypted"))).toBe(false);
    });
  });

  describe("S3", () => {
    it("flags missing encryption config", () => {
      const hints = securityPosture(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-bucket",
      });
      expect(hints.some((h) => h.includes("No explicit encryption"))).toBe(
        true,
      );
    });

    it("flags missing public access block", () => {
      const hints = securityPosture(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-bucket",
      });
      expect(
        hints.some((h) => h.includes("Public access block not configured")),
      ).toBe(true);
    });

    it("confirms public access when fully blocked", () => {
      const hints = securityPosture(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-bucket",
        BucketEncryption: { ServerSideEncryptionConfiguration: [] },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
      expect(hints.some((h) => h.includes("Public access fully blocked"))).toBe(
        true,
      );
    });
  });

  describe("RDS", () => {
    it("flags missing storage encryption", () => {
      const hints = securityPosture(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceClass: "db.t3.micro",
        Engine: "postgres",
      });
      expect(
        hints.some((h) => h.includes("storage encryption is disabled")),
      ).toBe(true);
    });

    it("flags missing Multi-AZ for production intent", () => {
      const hints = securityPosture(
        RESOURCE_TYPES.RDS_DB_INSTANCE,
        {
          DBInstanceClass: "db.t3.micro",
          Engine: "postgres",
          StorageEncrypted: true,
        },
        "Create a production database",
      );
      expect(
        hints.some((h) => h.includes("Production database without Multi-AZ")),
      ).toBe(true);
    });

    it("does not flag Multi-AZ for dev intent", () => {
      const hints = securityPosture(
        RESOURCE_TYPES.RDS_DB_INSTANCE,
        {
          DBInstanceClass: "db.t3.micro",
          Engine: "postgres",
          StorageEncrypted: true,
        },
        "Create a dev database",
      );
      expect(hints.some((h) => h.includes("Multi-AZ"))).toBe(false);
    });
  });

  describe("Security Group", () => {
    it("flags SSH open to 0.0.0.0/0", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_SECURITY_GROUP, {
        GroupDescription: "web server sg",
        SecurityGroupIngress: [
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" },
        ],
      });
      expect(
        hints.some((h) =>
          h.includes("SSH (port 22) is open to the entire internet"),
        ),
      ).toBe(true);
    });

    it("does not flag HTTPS on 0.0.0.0/0", () => {
      const hints = securityPosture(RESOURCE_TYPES.EC2_SECURITY_GROUP, {
        GroupDescription: "web server sg",
        SecurityGroupIngress: [
          {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIp: "0.0.0.0/0",
          },
        ],
      });
      expect(hints).toHaveLength(0);
    });
  });

  describe("unsupported types", () => {
    it("returns empty for CloudWatch Alarm", () => {
      const hints = securityPosture(RESOURCE_TYPES.CLOUDWATCH_ALARM, {
        AlarmName: "test",
      });
      expect(hints).toHaveLength(0);
    });
  });
});
