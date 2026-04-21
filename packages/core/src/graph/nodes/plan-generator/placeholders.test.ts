/**
 * Unit tests for plan-generator/placeholders.ts — focused on the SRP
 * behaviour of each exported helper, independent of the node wiring.
 */
import { describe, it, expect } from "vitest";
import {
  isPlaceholderArn,
  isTemplatePlaceholder,
  stripEmpty,
  stripPlaceholderArns,
  TEMPLATE_PLACEHOLDER_MARKERS,
} from "./placeholders.js";

describe("placeholders direct import", () => {
  describe("TEMPLATE_PLACEHOLDER_MARKERS", () => {
    it("includes the documented marker substrings", () => {
      for (const marker of [
        "my-",
        "your-",
        "...",
        "example",
        "12345",
        "(leave blank",
        "(auto-generated",
      ]) {
        expect(TEMPLATE_PLACEHOLDER_MARKERS).toContain(marker);
      }
    });
  });

  describe("isTemplatePlaceholder", () => {
    it("flags obvious template placeholders", () => {
      expect(isTemplatePlaceholder("my-bucket")).toBe(true);
      expect(isTemplatePlaceholder("your-role")).toBe(true);
      expect(isTemplatePlaceholder("arn:aws:iam::123456789012:role/...")).toBe(
        true,
      );
      expect(isTemplatePlaceholder("Brief description of the thing")).toBe(
        true,
      );
    });

    it("does NOT flag valid-shaped real values", () => {
      expect(isTemplatePlaceholder("10.0.1.0/24")).toBe(false);
      expect(isTemplatePlaceholder("index.handler")).toBe(false);
      expect(isTemplatePlaceholder("30")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isTemplatePlaceholder("MY-BUCKET")).toBe(true);
    });
  });

  describe("stripEmpty", () => {
    it("strips null, undefined, '' and []", () => {
      const result = stripEmpty({
        a: 1,
        b: null,
        c: undefined,
        d: "",
        e: [],
        f: "keep",
      });
      expect(result).toEqual({ a: 1, f: "keep" });
    });

    it("recursively strips nested empty objects", () => {
      const result = stripEmpty({ nested: { inner: "" }, keep: { x: 1 } });
      expect(result).toEqual({ keep: { x: 1 } });
    });

    it("strips string values that match the placeholder set", () => {
      const result = stripEmpty(
        { a: "my-bucket", b: "real-value" },
        new Set(["my-bucket"]),
      );
      expect(result).toEqual({ b: "real-value" });
    });
  });

  describe("isPlaceholderArn", () => {
    it("true for canonical AWS docs account ids across partitions", () => {
      expect(isPlaceholderArn("arn:aws:sns:us-east-1:123456789012:Topic")).toBe(
        true,
      );
      expect(
        isPlaceholderArn(
          "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/abc",
        ),
      ).toBe(true);
      expect(
        isPlaceholderArn(
          "arn:aws-cn:secretsmanager:cn-north-1:000000000000:secret:x",
        ),
      ).toBe(true);
    });

    it("false for real-account ARNs and non-ARN strings", () => {
      expect(
        isPlaceholderArn("arn:aws:iam::210987654321:role/assignee-operator"),
      ).toBe(false);
      expect(isPlaceholderArn("arn:aws:sns:us-east-1:987654321098:Real")).toBe(
        false,
      );
      expect(isPlaceholderArn("not-an-arn")).toBe(false);
      expect(isPlaceholderArn("")).toBe(false);
      expect(isPlaceholderArn(42)).toBe(false);
      expect(isPlaceholderArn(undefined)).toBe(false);
    });
  });

  describe("stripPlaceholderArns", () => {
    it("removes ARNs with canonical AWS docs account ids", () => {
      const state = {
        AlarmActions: [
          "arn:aws:sns:us-east-1:123456789012:Topic",
          "arn:aws:sns:us-east-1:210987654321:Real",
        ],
      };
      stripPlaceholderArns(state);
      expect(state.AlarmActions).toEqual([
        "arn:aws:sns:us-east-1:210987654321:Real",
      ]);
    });

    it("deletes the field when every element is a placeholder", () => {
      const state: Record<string, unknown> = {
        AlarmActions: ["arn:aws:sns:us-east-1:123456789012:Topic"],
      };
      stripPlaceholderArns(state);
      expect(state["AlarmActions"]).toBeUndefined();
    });

    // Epic 92 finding C-01: RDS Postgres default plan fails first attempt
    // because the LLM emits a placeholder PerformanceInsightsKMSKeyId
    // ARN and the pre-Epic-92 stripper only walked top-level arrays.
    it("strips scalar PerformanceInsightsKMSKeyId placeholder (C-01 RDS Postgres)", () => {
      // Captured from actual LLM response — account redacted to
      // <ACCOUNT_ID>=123456789012 so the placeholder trips the walker.
      const state: Record<string, unknown> = {
        DBInstanceIdentifier: "prod-postgres",
        Engine: "postgres",
        AllocatedStorage: 20,
        MasterUsername: "admin",
        PerformanceInsightsKMSKeyId:
          "arn:aws:kms:us-west-2:123456789012:key/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      };
      stripPlaceholderArns(state);
      expect(state["PerformanceInsightsKMSKeyId"]).toBeUndefined();
      // All other fields preserved
      expect(state["DBInstanceIdentifier"]).toBe("prod-postgres");
      expect(state["Engine"]).toBe("postgres");
      expect(state["AllocatedStorage"]).toBe(20);
      expect(state["MasterUsername"]).toBe("admin");
    });

    // Epic 92 finding C-02: simple-intent RDS retry re-introduces placeholder
    // via DomainAuthSecretArn.
    it("strips scalar DomainAuthSecretArn placeholder (C-02 RDS Postgres retry)", () => {
      const state: Record<string, unknown> = {
        DBInstanceIdentifier: "simple-postgres",
        Engine: "postgres",
        DomainAuthSecretArn:
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:rdsdb-domain-credentials-123456",
      };
      stripPlaceholderArns(state);
      expect(state["DomainAuthSecretArn"]).toBeUndefined();
      expect(state["DBInstanceIdentifier"]).toBe("simple-postgres");
    });

    it("strips scalar KmsKeyId placeholder across partitions (GovCloud)", () => {
      const state: Record<string, unknown> = {
        KmsKeyId: "arn:aws-us-gov:kms:us-gov-west-1:111122223333:key/abc",
      };
      stripPlaceholderArns(state);
      expect(state["KmsKeyId"]).toBeUndefined();
    });

    it("preserves real scalar ARNs with non-placeholder account IDs", () => {
      const state: Record<string, unknown> = {
        Role: "arn:aws:iam::210987654321:role/assignee-operator",
        KmsKeyId: "arn:aws:kms:us-west-2:987654321098:key/real-key",
      };
      stripPlaceholderArns(state);
      expect(state["Role"]).toBe(
        "arn:aws:iam::210987654321:role/assignee-operator",
      );
      expect(state["KmsKeyId"]).toBe(
        "arn:aws:kms:us-west-2:987654321098:key/real-key",
      );
    });

    it("recurses into nested objects and deletes emptied parents", () => {
      const state: Record<string, unknown> = {
        MasterUserSecret: {
          SecretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:x",
        },
        Config: {
          KeepMe: "real-value",
          BadArn: "arn:aws:kms:us-east-1:444455556666:key/placeholder",
        },
      };
      stripPlaceholderArns(state);
      // Nested object that only contained a placeholder → parent key deleted
      expect(state["MasterUserSecret"]).toBeUndefined();
      // Sibling keys on Config survive; only the placeholder field was dropped
      expect(state["Config"]).toEqual({ KeepMe: "real-value" });
    });

    it("recurses into nested arrays of objects (CF Distribution-style)", () => {
      const state: Record<string, unknown> = {
        Origins: [
          {
            DomainName: "example-origin.com",
            OriginShield: {
              OriginShieldRegion: "us-east-1",
              KmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/x",
            },
          },
        ],
      };
      stripPlaceholderArns(state);
      expect(state["Origins"]).toEqual([
        {
          DomainName: "example-origin.com",
          OriginShield: { OriginShieldRegion: "us-east-1" },
        },
      ]);
    });

    it("does not touch non-ARN scalar fields", () => {
      const state: Record<string, unknown> = {
        Name: "my-bucket",
        Count: 42,
        Enabled: true,
      };
      stripPlaceholderArns(state);
      expect(state["Name"]).toBe("my-bucket");
      expect(state["Count"]).toBe(42);
      expect(state["Enabled"]).toBe(true);
    });

    it("does not touch EC2 resource IDs — that's placeholder-resource-id guard's job", () => {
      const state: Record<string, unknown> = {
        SecurityGroupIds: ["sg-12345678", "sg-abcdef01"],
        SubnetId: "subnet-12345678",
      };
      stripPlaceholderArns(state);
      // Stripper is ARN-only; the placeholder-resource-id preflight guard
      // catches these.
      expect(state["SecurityGroupIds"]).toEqual(["sg-12345678", "sg-abcdef01"]);
      expect(state["SubnetId"]).toBe("subnet-12345678");
    });

    it("is cycle-safe (depth-capped)", () => {
      // Build a 40-deep nest of objects; walker caps at 32, must not throw.
      const root: Record<string, unknown> = {};
      let cursor: Record<string, unknown> = root;
      for (let i = 0; i < 40; i++) {
        const next: Record<string, unknown> = {};
        cursor["next"] = next;
        cursor = next;
      }
      cursor["Arn"] = "arn:aws:kms:us-east-1:123456789012:key/deep";
      expect(() => stripPlaceholderArns(root)).not.toThrow();
    });
  });
});
