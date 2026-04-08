import { describe, it, expect } from "vitest";
import {
  analyzeRdsSecretsIntegration,
  planNeedsRdsSecretsIntegration,
  secretDynamicReference,
  RDS_SAFE_EXCLUDE_CHARACTERS,
  DEFAULT_PASSWORD_LENGTH,
} from "./rds-secretsmanager.js";

describe("analyzeRdsSecretsIntegration", () => {
  describe("auto-suggestion trigger", () => {
    it("suggests SecretsManager when no MasterUserPassword is provided", () => {
      // Tier C: strengthened — assert the actual shape of each resource,
      // not just defined-ness. The secret/attachment must have the right
      // CFN type or the integration is silently broken.
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres", DBInstanceClass: "db.t3.micro" },
        "MyDatabase",
      );

      expect(result.shouldSuggest).toBe(true);
      expect(result.userProvidedPassword).toBe(false);
      expect(result.secretResource).toMatchObject({
        type: "AWS::SecretsManager::Secret",
      });
      expect(result.attachmentResource).toMatchObject({
        type: "AWS::SecretsManager::SecretTargetAttachment",
      });
      // dynamicReference is the resolve:secretsmanager template literal
      expect(result.dynamicReference).toMatch(
        /^\{\{resolve:secretsmanager:\$\{[\w-]+Secret\}:SecretString:password\}\}$/,
      );
    });

    it("suggests SecretsManager when MasterUserPassword is empty string", () => {
      const result = analyzeRdsSecretsIntegration({
        Engine: "postgres",
        MasterUserPassword: "",
      });

      expect(result.shouldSuggest).toBe(true);
    });
  });

  describe("generated secret config", () => {
    it("has ExcludeCharacters set to RDS-safe characters", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      const genString = result.secretResource?.properties[
        "GenerateSecretString"
      ] as Record<string, unknown>;
      expect(genString["ExcludeCharacters"]).toBe(RDS_SAFE_EXCLUDE_CHARACTERS);
      expect(RDS_SAFE_EXCLUDE_CHARACTERS).toBe("/@\"\\'");
    });

    it("has PasswordLength set to 32", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      const genString = result.secretResource?.properties[
        "GenerateSecretString"
      ] as Record<string, unknown>;
      expect(genString["PasswordLength"]).toBe(DEFAULT_PASSWORD_LENGTH);
      expect(DEFAULT_PASSWORD_LENGTH).toBe(32);
    });

    it("uses SecretStringTemplate with username admin", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      const genString = result.secretResource?.properties[
        "GenerateSecretString"
      ] as Record<string, unknown>;
      expect(genString["SecretStringTemplate"]).toBe(
        JSON.stringify({ username: "admin" }),
      );
      expect(genString["GenerateStringKey"]).toBe("password");
    });
  });

  describe("dynamic reference format", () => {
    it("produces correct dynamic reference", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      expect(result.dynamicReference).toBe(
        "{{resolve:secretsmanager:${MyDBSecret}:SecretString:password}}",
      );
    });
  });

  describe("SecretTargetAttachment companion resource", () => {
    it("is included in the result with the correct CFN type", () => {
      // Tier C: collapsed redundant toBeDefined into the type assertion
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      expect(result.attachmentResource).toMatchObject({
        type: "AWS::SecretsManager::SecretTargetAttachment",
      });
    });

    it("has correct SecretId and TargetId references", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "MyDB",
      );

      expect(result.attachmentResource?.properties["SecretId"]).toEqual({
        Ref: "MyDBSecret",
      });
      expect(result.attachmentResource?.properties["TargetId"]).toEqual({
        Ref: "MyDB",
      });
      expect(result.attachmentResource?.properties["TargetType"]).toBe(
        "AWS::RDS::DBInstance",
      );
    });
  });

  describe("user opt-out", () => {
    it("skips auto-suggestion when MasterUserPassword is explicitly provided", () => {
      const result = analyzeRdsSecretsIntegration({
        Engine: "postgres",
        MasterUserPassword: "MyStr0ngP@ssw0rd!",
      });

      expect(result.shouldSuggest).toBe(false);
      expect(result.userProvidedPassword).toBe(true);
      expect(result.secretResource).toBeUndefined();
      expect(result.attachmentResource).toBeUndefined();
      expect(result.dynamicReference).toBeUndefined();
    });
  });

  describe("logical ID derivation", () => {
    it("derives secret and attachment logical IDs from RDS logical ID", () => {
      const result = analyzeRdsSecretsIntegration(
        { Engine: "postgres" },
        "ProductionDB",
      );

      expect(result.secretResource?.logicalId).toBe("ProductionDBSecret");
      expect(result.attachmentResource?.logicalId).toBe(
        "ProductionDBSecretAttachment",
      );
    });

    it("uses default logical ID when none provided", () => {
      const result = analyzeRdsSecretsIntegration({ Engine: "postgres" });

      expect(result.secretResource?.logicalId).toBe("DatabaseInstanceSecret");
      expect(result.attachmentResource?.logicalId).toBe(
        "DatabaseInstanceSecretAttachment",
      );
    });
  });
});

describe("secretDynamicReference", () => {
  it("returns correct dynamic reference format", () => {
    expect(secretDynamicReference("MySecret")).toBe(
      "{{resolve:secretsmanager:${MySecret}:SecretString:password}}",
    );
  });
});

describe("planNeedsRdsSecretsIntegration", () => {
  it("returns true when plan has RDS without password", () => {
    expect(
      planNeedsRdsSecretsIntegration([
        {
          resourceType: "AWS::RDS::DBInstance",
          desiredState: { Engine: "postgres" },
        },
      ]),
    ).toBe(true);
  });

  it("returns false when plan has RDS with password", () => {
    expect(
      planNeedsRdsSecretsIntegration([
        {
          resourceType: "AWS::RDS::DBInstance",
          desiredState: {
            Engine: "postgres",
            MasterUserPassword: "secret123",
          },
        },
      ]),
    ).toBe(false);
  });

  it("returns false when plan has no RDS", () => {
    expect(
      planNeedsRdsSecretsIntegration([
        {
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "my-bucket" },
        },
      ]),
    ).toBe(false);
  });
});
