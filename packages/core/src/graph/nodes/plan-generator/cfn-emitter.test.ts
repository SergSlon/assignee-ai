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

    // ── PD-4 lifecycle tests ─────────────────────────────────────────────
    describe("lifecycle — PD-4 expire-only path (LifecycleExpireOnly=true)", () => {
      it("Variation A — bare 'lifecycle 30d': emits expire-only rule, no Transitions", () => {
        // Simulates what the s3-lifecycle-extractor sets for "Create an S3 bucket with lifecycle 30d"
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: true,
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "30",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        expect(lc).toBeDefined();
        expect(lc.Rules).toHaveLength(1);
        const rule = lc.Rules[0]!;
        expect(rule[CfnKey.EXPIRATION_IN_DAYS]).toBe(30);
        expect(rule["Transitions"]).toBeUndefined();
        // PD-4 stable Id preserved for current-only expire path
        expect(rule["Id"]).toBe("assignee-default-lifecycle");
      });

      it("Variation D — lifecycle 90d: emits ExpirationInDays=90, no Transitions", () => {
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: true,
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "90",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        expect(lc.Rules[0]![CfnKey.EXPIRATION_IN_DAYS]).toBe(90);
        expect(lc.Rules[0]!["Transitions"]).toBeUndefined();
      });

      it("expire-only path cleans up wizard-only keys from transformed", () => {
        const transformed: Record<string, unknown> = {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: true,
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "30",
        };
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: true,
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "30",
        });
        expect(transformed[CfnKey.ENABLE_LIFECYCLE]).toBeUndefined();
        expect(transformed[CfnKey.LIFECYCLE_EXPIRE_ONLY]).toBeUndefined();
        expect(transformed[CfnKey.LIFECYCLE_EXPIRATION_DAYS]).toBeUndefined();
      });
    });

    describe("lifecycle — Variation B: explicit transition + expire ladder", () => {
      it("emits Transitions + ExpirationInDays when LifecycleExpireOnly is absent", () => {
        // Simulates: "transition to IA after 30 days then expire after 90 days"
        // No LifecycleExpireOnly flag → full multi-rule path.
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_TRANSITION_DAYS]: "30",
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "90",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        expect(lc).toBeDefined();
        const rule = lc.Rules[0]!;
        const transitions = rule["Transitions"] as Array<{
          StorageClass: string;
          TransitionInDays: number;
        }>;
        expect(transitions).toHaveLength(1);
        expect(transitions[0]!.StorageClass).toBe("STANDARD_IA");
        expect(transitions[0]!.TransitionInDays).toBe(30);
        expect(rule[CfnKey.EXPIRATION_IN_DAYS]).toBe(90);
      });
    });

    describe("lifecycle — Variation C: no lifecycle keyword", () => {
      it("emits no LifecycleConfiguration when EnableLifecycle is absent", () => {
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.BUCKET_ENCRYPTION]: false,
        });
        expect(transformed[CfnKey.LIFECYCLE_CONFIGURATION]).toBeUndefined();
      });
    });

    describe("lifecycle — Variation E: explicit --set Transitions override", () => {
      it("full multi-rule path when LifecycleExpireOnly is explicitly false", () => {
        // Simulates --set with explicit Transitions override
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: false,
          [CfnKey.LIFECYCLE_TRANSITION_DAYS]: "60",
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "180",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        const rule = lc.Rules[0]!;
        const transitions = rule["Transitions"] as Array<{
          StorageClass: string;
          TransitionInDays: number;
        }>;
        expect(transitions[0]!.StorageClass).toBe("STANDARD_IA");
        expect(transitions[0]!.TransitionInDays).toBe(60);
        expect(rule[CfnKey.EXPIRATION_IN_DAYS]).toBe(180);
      });
    });

    // ── PH5-8-A NoncurrentVersion tests ─────────────────────────────────────
    describe("lifecycle — PH5-8-A noncurrent-version path", () => {
      it("NC-A: noncurrent-only emits NoncurrentVersionExpirationInDays=30, no ExpirationInDays", () => {
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "30",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        expect(lc).toBeDefined();
        expect(lc.Rules).toHaveLength(1);
        const rule = lc.Rules[0]!;
        expect(rule[CfnKey.NONCURRENT_VERSION_EXPIRATION_IN_DAYS]).toBe(30);
        expect(rule[CfnKey.EXPIRATION_IN_DAYS]).toBeUndefined();
        expect(rule["Transitions"]).toBeUndefined();
        // EPIC-106-5 nit: noncurrent-only gets content-addressed Id
        expect(rule["Id"]).toBe("delete-old-versions-after-30d");
      });

      it("NC-A: noncurrent-only auto-enables VersioningConfiguration", () => {
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "30",
        });
        expect(transformed[CfnKey.VERSIONING_CONFIGURATION]).toEqual({
          Status: "Enabled",
        });
      });

      it("NC-A: noncurrent-only does NOT overwrite existing VersioningConfiguration", () => {
        const transformed: Record<string, unknown> = {
          [CfnKey.VERSIONING_CONFIGURATION]: { Status: "Suspended" },
        };
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "30",
        });
        // Should preserve existing versioning config, not overwrite
        expect(transformed[CfnKey.VERSIONING_CONFIGURATION]).toEqual({
          Status: "Suspended",
        });
      });

      it("NC-C: both current AND noncurrent emits both fields in one rule", () => {
        const transformed: Record<string, unknown> = {};
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_EXPIRE_ONLY]: true,
          [CfnKey.LIFECYCLE_EXPIRATION_DAYS]: "30",
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "7",
        });
        const lc = transformed[CfnKey.LIFECYCLE_CONFIGURATION] as {
          Rules: Array<Record<string, unknown>>;
        };
        expect(lc.Rules).toHaveLength(1);
        const rule = lc.Rules[0]!;
        expect(rule[CfnKey.EXPIRATION_IN_DAYS]).toBe(30);
        expect(rule[CfnKey.NONCURRENT_VERSION_EXPIRATION_IN_DAYS]).toBe(7);
        expect(rule["Transitions"]).toBeUndefined();
        // EPIC-106-5 nit: Variation C uses a descriptive combined rule Id,
        // not the PD-4 "assignee-default-lifecycle" stable Id.
        expect(rule["Id"]).toBe("expire-and-delete-old-versions");
      });

      it("noncurrent cleans up wizard-only key from transformed", () => {
        const transformed: Record<string, unknown> = {
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "30",
        };
        assembleS3Composites(transformed, {
          [CfnKey.ENABLE_LIFECYCLE]: true,
          [CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS]: "30",
        });
        expect(
          transformed[CfnKey.LIFECYCLE_NONCURRENT_EXPIRATION_DAYS],
        ).toBeUndefined();
      });
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
