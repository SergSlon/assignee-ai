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

  it("strips [REDACTED] string elements from an array of strings (W1-H1)", () => {
    // An array with mixed redacted + plain string elements — redacted
    // elements must be removed; plain elements must be kept.
    const input = {
      Regions: [REDACTED_VALUE, "us-east-1", REDACTED_VALUE, "eu-west-1"],
    };
    const stripped = stripRedactedFields(input);
    expect(stripped["Regions"]).toEqual(["us-east-1", "eu-west-1"]);
  });

  it("recurses into array-of-objects, stripping [REDACTED] fields (W1-H1)", () => {
    // Object elements inside an array must be recursed into — their
    // REDACTED fields stripped, their clean fields preserved.
    const input = {
      AccessKeys: [
        { AccessKeyId: "AKID-1", SecretAccessKey: REDACTED_VALUE },
        { AccessKeyId: "AKID-2", SecretAccessKey: REDACTED_VALUE },
      ],
    };
    const stripped = stripRedactedFields(input);
    const arr = stripped["AccessKeys"] as Array<Record<string, unknown>>;
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({ AccessKeyId: "AKID-1" });
    expect(arr[1]).toEqual({ AccessKeyId: "AKID-2" });
  });

  it("handles nested arrays (array inside object inside array) (W1-H1)", () => {
    // Arbitrary-depth nesting: array element is an object whose value
    // is itself another array containing REDACTED_VALUE entries.
    const input = {
      Groups: [
        {
          GroupName: "admins",
          Passwords: [REDACTED_VALUE, REDACTED_VALUE],
          Members: ["alice", "bob"],
        },
      ],
    };
    const stripped = stripRedactedFields(input);
    const groups = stripped["Groups"] as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!["GroupName"]).toBe("admins");
    // All REDACTED elements removed from inner array
    expect(groups[0]!["Passwords"]).toEqual([]);
    // Clean array elements preserved
    expect(groups[0]!["Members"]).toEqual(["alice", "bob"]);
  });

  it("returns empty array unchanged when array has no [REDACTED] elements (W1-H1)", () => {
    // Clean arrays must not be mutated or drop elements.
    const input = {
      Tags: [
        { Key: "Env", Value: "production" },
        { Key: "Owner", Value: "assignee" },
      ],
      Cidrs: ["10.0.0.0/8", "192.168.0.0/16"],
      Empty: [] as unknown[],
    };
    const stripped = stripRedactedFields(input);
    expect(stripped["Tags"]).toEqual(input.Tags);
    expect(stripped["Cidrs"]).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(stripped["Empty"]).toEqual([]);
  });

  it("mixed array: plain values + nested objects + [REDACTED] elements (W1-H1)", () => {
    // The most complex case: all three element types in a single array.
    const input = {
      Entries: [
        "keep-me",
        REDACTED_VALUE,
        { Name: "obj1", Secret: REDACTED_VALUE, Keep: "yes" },
        42,
        REDACTED_VALUE,
      ],
    };
    const stripped = stripRedactedFields(input);
    expect(stripped["Entries"]).toEqual([
      "keep-me",
      { Name: "obj1", Keep: "yes" },
      42,
    ]);
  });

  it("empty object in → empty object out", () => {
    expect(stripRedactedFields({})).toEqual({});
  });
});

// ── W1-01 (Epic 100): cooperation between CFN allowlist and elicited-field marker ──
//
// The checkpoint redaction layer (allowlist-based, key-name exact match) and
// the W1 elicited-field marker (sensitive: true on ResourceField) are ADDITIVE
// layers that both target write boundaries. This suite pins that:
//   - redactSensitiveFields covers the CFN desiredState layer (existing).
//   - stripSensitiveFromElicited covers the elicited-options layer (W1).
//   - Both use the same placeholder string "[REDACTED]".
//   - A field that is BOTH in the CFN allowlist AND marked sensitive: true
//     is scrubbed by EITHER layer independently (belt-and-suspenders).
//
// This confirms that checkpoint serialization is additive, not competing.

describe("W1-01 integration — CFN allowlist cooperates with elicited-field marker", () => {
  it("REDACTED_VALUE equals ELICITED_REDACTED_VALUE (same sentinel, both layers compatible)", async () => {
    const { ELICITED_REDACTED_VALUE } = await import("../utils/redact.js");
    // Both layers must produce the same placeholder so checkpoint-resume
    // and pattern-record reads can rely on a single sentinel string.
    expect(REDACTED_VALUE).toBe(ELICITED_REDACTED_VALUE);
    expect(REDACTED_VALUE).toBe("[REDACTED]");
  });

  it("CFN allowlist redacts MasterUserPassword in desiredState (existing path)", () => {
    const desiredState = {
      DBName: "myapp",
      MasterUserPassword: "secret-canary-12345",
      Engine: "postgres",
    };
    const redacted = redactSensitiveFields(desiredState);
    expect(redacted["MasterUserPassword"]).toBe(REDACTED_VALUE);
    expect(redacted["DBName"]).toBe("myapp");
    expect(JSON.stringify(redacted)).not.toContain("secret-canary-12345");
  });

  it("elicited-field marker independently scrubs the same field name in elicited-options", async () => {
    const { stripSensitiveFromElicited } = await import("../utils/redact.js");
    const elicitedOptions = {
      DBName: "myapp",
      MasterUserPassword: "secret-canary-12345",
    };
    const sensitive = new Set(["MasterUserPassword"]);
    const safe = stripSensitiveFromElicited(elicitedOptions, sensitive);
    expect(safe["MasterUserPassword"]).toBe("[REDACTED]");
    expect(safe["DBName"]).toBe("myapp");
    expect(JSON.stringify(safe)).not.toContain("secret-canary-12345");
  });

  it("a record processed by both layers is fully scrubbed (belt-and-suspenders)", async () => {
    const { stripSensitiveFromElicited } = await import("../utils/redact.js");
    const raw = {
      DBName: "myapp",
      MasterUserPassword: "secret-canary-12345",
      SecretString: "another-secret-canary-67890",
    };
    const sensitive = new Set(["MasterUserPassword", "SecretString"]);
    // Layer 1: elicited-field marker (W1)
    const afterW1 = stripSensitiveFromElicited(raw, sensitive);
    // Layer 2: CFN allowlist (existing checkpoint layer)
    const afterCfn = redactSensitiveFields(afterW1 as Record<string, unknown>);
    // After both layers, no credential appears in the result
    const serialized = JSON.stringify(afterCfn);
    expect(serialized).not.toContain("secret-canary-12345");
    expect(serialized).not.toContain("another-secret-canary-67890");
    expect(afterCfn["DBName"]).toBe("myapp");
  });
});
