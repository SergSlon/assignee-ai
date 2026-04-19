/**
 * Unit tests for plan-generator/cfn-emitter.ts — verifies the SRP
 * transforms + the OCP registry dispatch (composite assemblers keyed by
 * resource type).
 */
import { describe, it, expect } from "vitest";
import { CfnKey, RESOURCE_TYPES } from "@/index.js";
import {
  applyToCfnTransforms,
  assembleS3Composites,
  assembleEc2Storage,
} from "./cfn-emitter.js";

describe("cfn-emitter direct import", () => {
  describe("applyToCfnTransforms", () => {
    it("returns the input unchanged for an unknown resource type", () => {
      const input = { foo: "bar" };
      expect(applyToCfnTransforms(input, "AWS::Unknown::Thing")).toBe(input);
    });

    it("dispatches to the S3 composite assembler via the registry", () => {
      // Enable encryption triggers the S3 assembler's composite branch
      const result = applyToCfnTransforms(
        { [CfnKey.BUCKET_ENCRYPTION]: true },
        RESOURCE_TYPES.S3_BUCKET,
      );
      // BucketEncryption key should now be a composite object, not a bool
      expect(typeof result[CfnKey.BUCKET_ENCRYPTION]).toBe("object");
    });
  });

  describe("assembleS3Composites", () => {
    it("produces a SSE-KMS encryption block when a key is supplied", () => {
      const transformed: Record<string, unknown> = {};
      assembleS3Composites(transformed, {
        [CfnKey.BUCKET_ENCRYPTION]: true,
        [CfnKey.KMS_MASTER_KEY_ID_S3]: "alias/my-key",
      });
      const enc = transformed[CfnKey.BUCKET_ENCRYPTION] as {
        ServerSideEncryptionConfiguration: Array<{
          ServerSideEncryptionByDefault: { SSEAlgorithm: string };
        }>;
      };
      expect(
        enc.ServerSideEncryptionConfiguration[0]!.ServerSideEncryptionByDefault
          .SSEAlgorithm,
      ).toBe("aws:kms");
    });

    it("deletes encryption when flag is false", () => {
      const transformed: Record<string, unknown> = {
        [CfnKey.BUCKET_ENCRYPTION]: true,
      };
      assembleS3Composites(transformed, {
        [CfnKey.BUCKET_ENCRYPTION]: false,
      });
      expect(transformed[CfnKey.BUCKET_ENCRYPTION]).toBeUndefined();
    });
  });

  describe("assembleEc2Storage", () => {
    it("produces a BlockDeviceMappings entry when any EBS field is provided", () => {
      const transformed: Record<string, unknown> = {};
      assembleEc2Storage(transformed, {
        [CfnKey.EBS_VOLUME_SIZE]: "16",
        [CfnKey.EBS_ENCRYPTED]: true,
      });
      const bdm = transformed[CfnKey.BLOCK_DEVICE_MAPPINGS] as Array<{
        Ebs: Record<string, unknown>;
      }>;
      expect(bdm[0]!.Ebs[CfnKey.VOLUME_SIZE]).toBe(16);
      expect(bdm[0]!.Ebs[CfnKey.ENCRYPTED]).toBe(true);
    });

    it("emits no BlockDeviceMappings when all EBS fields are absent", () => {
      const transformed: Record<string, unknown> = {};
      assembleEc2Storage(transformed, {});
      expect(transformed[CfnKey.BLOCK_DEVICE_MAPPINGS]).toBeUndefined();
    });
  });
});
