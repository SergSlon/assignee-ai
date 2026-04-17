/**
 * Dedicated unit tests for checkpoint redaction (Story 50-6).
 *
 * Covers feedback_redaction_allowlist_not_denylist — the allowlist is
 * an explicit key-name list, NOT a regex denylist. A regex denylist
 * would over-match on legitimate CloudFormation property names that
 * share substrings with credential terms (e.g. PasswordPolicy,
 * UserData, TokenValidityUnits). Redacting those would silently strip
 * critical infrastructure config on checkpoint resume.
 *
 * This suite pins:
 *
 *   - Every allowlist key round-trips to "[REDACTED]" at top, nested,
 *     and array positions.
 *   - Keys that only SHARE a substring with credential words are NOT
 *     over-redacted (PasswordPolicy, UserData, TokenValidityUnits,
 *     PasswordResetRequired, CredentialReportExpiration).
 *   - Defense-in-depth: AKIA / ASIA values inside innocuous keys are
 *     scrubbed regardless of key name.
 *   - stripRedactedFields drops the placeholder and preserves the rest
 *     of the object shape (AWS default-on-resume semantics).
 */
import { describe, it, expect } from "vitest";
import {
  redactSensitiveFields,
  stripRedactedFields,
  REDACTED_VALUE,
} from "./redaction.js";

describe("redactSensitiveFields — allowlist coverage", () => {
  it.each([
    "MasterUserPassword",
    "MasterPassword",
    "AdminPassword",
    "DefaultPassword",
    "DefaultUserPassword",
    "Password",
    "SecretString",
    "SecretAccessKey",
    "SessionToken",
    "PrivateKey",
    "PrivateKeyPassphrase",
    "RSAPrivateKey",
    "BootstrapToken",
  ])("redacts top-level %s", (key) => {
    const input = { [key]: "s3cret-value-should-NEVER-leak" };
    const result = redactSensitiveFields(input);
    expect(result[key]).toBe(REDACTED_VALUE);
  });

  it("redacts inside a nested object (Cognito UserPool-ish shape)", () => {
    const input = {
      UserPoolName: "assignee-prod-users",
      Policies: {
        MasterUserPassword: "deep-secret-1",
      },
    };
    const result = redactSensitiveFields(input);
    expect(
      (result["Policies"] as Record<string, unknown>)["MasterUserPassword"],
    ).toBe(REDACTED_VALUE);
    // Non-sensitive sibling preserved.
    expect(result["UserPoolName"]).toBe("assignee-prod-users");
  });

  it("redacts inside an array-of-objects (IAM AccessKey list shape)", () => {
    const input = {
      AccessKeys: [
        { AccessKeyId: "AKIAABCDEFGHIJKLMNOP", SecretAccessKey: "real-secret" },
        { AccessKeyId: "AKIAZZZZZZZZZZZZZZZZ", SecretAccessKey: "another" },
      ],
    };
    const result = redactSensitiveFields(input);
    const arr = result["AccessKeys"] as Array<Record<string, unknown>>;
    expect(arr[0]!["SecretAccessKey"]).toBe(REDACTED_VALUE);
    expect(arr[1]!["SecretAccessKey"]).toBe(REDACTED_VALUE);
    // AccessKeyId is itself an AKIA — defense-in-depth scrubs the value
    // even though the KEY name isn't in the allowlist.
    expect(arr[0]!["AccessKeyId"]).toBe(REDACTED_VALUE);
    expect(arr[1]!["AccessKeyId"]).toBe(REDACTED_VALUE);
  });

  it("returns a new object (no mutation of the input)", () => {
    const input = { Password: "do-not-touch" };
    const frozen = Object.freeze({ ...input });
    expect(() => redactSensitiveFields(frozen)).not.toThrow();
    expect(frozen.Password).toBe("do-not-touch");
  });
});

describe("redactSensitiveFields — NOT over-redacted (allowlist precision)", () => {
  // These are the exact false-positive cases that motivated the switch
  // from regex-denylist to explicit-allowlist. See
  // feedback_redaction_allowlist_not_denylist. A substring-denylist
  // would wipe these fields silently on resume — never again.

  it("PasswordPolicy (Cognito UserPool) is NOT redacted", () => {
    const input = {
      PasswordPolicy: {
        MinimumLength: 12,
        RequireUppercase: true,
        RequireLowercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
      },
    };
    const result = redactSensitiveFields(input);
    expect(result["PasswordPolicy"]).toEqual(input.PasswordPolicy);
  });

  it("UserData (EC2 bootstrap script) is NOT redacted", () => {
    const input = {
      UserData:
        "#!/bin/bash\necho 'hello' > /var/log/boot.log\nsystemctl start nginx\n",
    };
    const result = redactSensitiveFields(input);
    expect(result["UserData"]).toBe(input.UserData);
  });

  it("TokenValidityUnits (Cognito JWT lifetime) is NOT redacted", () => {
    const input = {
      TokenValidityUnits: {
        AccessToken: "minutes",
        IdToken: "minutes",
        RefreshToken: "days",
      },
    };
    const result = redactSensitiveFields(input);
    expect(result["TokenValidityUnits"]).toEqual(input.TokenValidityUnits);
  });

  it("PasswordResetRequired (IAM LoginProfile flag) is NOT redacted", () => {
    const input = {
      PasswordResetRequired: true,
    };
    const result = redactSensitiveFields(input);
    expect(result["PasswordResetRequired"]).toBe(true);
  });

  it("CredentialReportExpiration (IAM metadata) is NOT redacted", () => {
    const input = {
      CredentialReportExpiration: "2026-04-17T00:00:00Z",
    };
    const result = redactSensitiveFields(input);
    expect(result["CredentialReportExpiration"]).toBe("2026-04-17T00:00:00Z");
  });

  it("a key literally named 'SecretString' IS redacted but 'SecretStringTemplate' is NOT", () => {
    // Allowlist is EXACT match — SecretsManager's top-level SecretString
    // is a credential payload; the SecretStringTemplate used by the
    // provisioner to request auto-generation is config (length, allowed
    // characters) with no secret value.
    const input = {
      SecretString: "real-db-password",
      SecretStringTemplate: JSON.stringify({ username: "admin" }),
    };
    const result = redactSensitiveFields(input);
    expect(result["SecretString"]).toBe(REDACTED_VALUE);
    expect(result["SecretStringTemplate"]).toBe(
      JSON.stringify({ username: "admin" }),
    );
  });

  it("key case-sensitivity: 'password' (lowercase) is NOT redacted", () => {
    // CloudFormation property names are PascalCase. A lowercase-'password'
    // key would come from a non-CFN shape (e.g. an operator-submitted
    // options payload). The allowlist is case-sensitive and deliberately
    // doesn't catch it — if callers want it covered they should normalise
    // keys before passing in.
    const input = { password: "not-a-cfn-key" };
    const result = redactSensitiveFields(input);
    expect(result["password"]).toBe("not-a-cfn-key");
  });
});

describe("redactSensitiveFields — AKIA / ASIA pattern defense-in-depth", () => {
  it("scrubs AKIA strings inside innocuous top-level keys", () => {
    const input = {
      Description: "access key is AKIAABCDEFGHIJKLMNOP for legacy user",
    };
    const result = redactSensitiveFields(input);
    // Current implementation replaces the WHOLE value when AKIA_PATTERN
    // matches (not just the matched substring). This is deliberate —
    // a message containing a leaked key is itself a leak vector.
    expect(result["Description"]).toBe(REDACTED_VALUE);
  });

  it("scrubs ASIA (short-term STS) strings the same way", () => {
    const input = { note: "temp creds ASIAABCDEFGHIJKLMNOP" };
    const result = redactSensitiveFields(input);
    expect(result["note"]).toBe(REDACTED_VALUE);
  });

  it("does NOT false-match on ARNs containing 'aws:iam' substrings", () => {
    // ARNs and bucket names look nothing like AKIA/ASIA patterns — pin
    // the narrowness of the pattern.
    const input = {
      RoleArn: "arn:aws:iam::123456789012:role/assignee-operator",
      BucketName: "AKIAlike-named-bucket-not-a-key", // starts with AKIA but wrong shape
    };
    const result = redactSensitiveFields(input);
    expect(result["RoleArn"]).toBe(input.RoleArn);
    // "AKIAlike-..." → followed by 'like-' which is lowercase, so not
    // 16 uppercase-alphanumeric chars → not matched.
    expect(result["BucketName"]).toBe(input.BucketName);
  });

  it("scrubs AKIA inside arrays", () => {
    const input = {
      Entries: ["normal", "AKIAZZZZZZZZZZZZZZZZ is a real access key"],
    };
    const result = redactSensitiveFields(input);
    const arr = result["Entries"] as unknown[];
    expect(arr[0]).toBe("normal");
    expect(arr[1]).toBe(REDACTED_VALUE);
  });

  it("scrubs AKIA deeply nested", () => {
    const input = {
      Config: {
        Legacy: {
          Notes: "old key AKIAABCDEFGHIJKLMNOP",
        },
      },
    };
    const result = redactSensitiveFields(input);
    const config = result["Config"] as Record<string, unknown>;
    const legacy = config["Legacy"] as Record<string, unknown>;
    expect(legacy["Notes"]).toBe(REDACTED_VALUE);
  });
});

describe("redactSensitiveFields — scalar preservation", () => {
  it("preserves numbers / booleans / nulls verbatim", () => {
    const input = {
      MinimumLength: 12,
      RequireUppercase: true,
      DeletionProtectionEnabled: false,
      EmptyValue: null,
    };
    const result = redactSensitiveFields(input);
    expect(result).toEqual(input);
  });

  it("empty object in → empty object out", () => {
    expect(redactSensitiveFields({})).toEqual({});
  });
});

describe("stripRedactedFields", () => {
  it("drops fields whose value is exactly [REDACTED]", () => {
    const redacted = redactSensitiveFields({
      DBName: "assignee-prod",
      MasterUserPassword: "xyz",
    });
    const stripped = stripRedactedFields(redacted);
    expect(stripped).toEqual({ DBName: "assignee-prod" });
    expect(stripped).not.toHaveProperty("MasterUserPassword");
  });

  it("recurses into nested objects", () => {
    const redacted = redactSensitiveFields({
      UserPoolName: "assignee-prod-users",
      Policies: {
        MasterUserPassword: "xyz",
        Retention: 30,
      },
    });
    const stripped = stripRedactedFields(redacted);
    expect(stripped).toEqual({
      UserPoolName: "assignee-prod-users",
      Policies: { Retention: 30 },
    });
  });

  it("preserves arrays (does not recurse into them — they stay as-is)", () => {
    // The stripper walks objects but treats arrays as opaque; the
    // prior redact step already replaced secret array elements with
    // REDACTED_VALUE which stays in place. Pin this.
    const redacted = redactSensitiveFields({
      AccessKeys: [{ SecretAccessKey: "xyz" }],
    });
    const stripped = stripRedactedFields(redacted);
    const arr = stripped["AccessKeys"] as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(1);
    // The inner map kept SecretAccessKey: [REDACTED] because the array
    // isn't walked by stripRedactedFields.
    expect(arr[0]).toEqual({ SecretAccessKey: REDACTED_VALUE });
  });

  it("empty object in → empty object out", () => {
    expect(stripRedactedFields({})).toEqual({});
  });
});
