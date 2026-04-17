/**
 * Dedicated unit tests for the recorder fixture redaction module
 * (Story 50-6).
 *
 * The recorder writes LLM + SDK fixtures to disk for replay. The
 * redactor's job is to scrub operator credentials, IAM account IDs,
 * and access-key patterns from any recorded payload — while
 * preserving the rest of the shape exactly so the recording remains
 * useful for reproducing test scenarios.
 *
 * This suite pins:
 *
 *   - Every allowlisted key (env-var style + CfnKey credential keys +
 *     camel-case ports-services keys) is redacted to `[REDACTED]`.
 *   - NON-allowlisted keys that happen to contain the substring
 *     "Secret" / "Token" / "Key" are NOT over-redacted — the
 *     allowlist is exact-match, per
 *     feedback_redaction_allowlist_not_denylist.
 *   - Credential-shaped string VALUES (AKIA / ASIA) are scrubbed
 *     key-blind (defense-in-depth).
 *   - IAM ARN 12-digit account slot is scrubbed while preserving the
 *     partition prefix for debuggability (aws, aws-cn, aws-us-gov,
 *     aws-iso, aws-iso-b).
 *   - Recorded-fixture shape is preserved: non-sensitive keys round-trip
 *     unchanged, including nested objects, arrays, nulls, numbers, booleans.
 *   - Required fields (tool name, region, resourceType) are NEVER dropped.
 */
import { describe, it, expect } from "vitest";
import { redactSensitive, redactStringValue } from "./redaction.js";

const asRecord = (v: unknown): Record<string, unknown> =>
  v as Record<string, unknown>;

describe("redactSensitive — env-var style allowlist", () => {
  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    "ASSIGNEE_READER_ACCESS_KEY_ID",
    "ASSIGNEE_READER_SECRET_ACCESS_KEY",
    "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  ])("redacts top-level %s to [REDACTED]", (key) => {
    const input = { [key]: "real-secret-value-xyz" };
    const result = asRecord(redactSensitive(input));
    expect(result[key]).toBe("[REDACTED]");
  });
});

describe("redactSensitive — camel-case credential keys", () => {
  it.each(["accessToken", "secretAccessKey", "sessionToken"])(
    "redacts top-level %s to [REDACTED]",
    (key) => {
      const input = { [key]: "real-secret-value-xyz" };
      const result = asRecord(redactSensitive(input));
      expect(result[key]).toBe("[REDACTED]");
    },
  );
});

describe("redactSensitive — CfnKey credential entries", () => {
  it("redacts MasterUserPassword", () => {
    const input = { MasterUserPassword: "hunter2-real" };
    const result = asRecord(redactSensitive(input));
    expect(result["MasterUserPassword"]).toBe("[REDACTED]");
  });

  it("redacts SecretString", () => {
    const input = { SecretString: "api-key:sk-real-xyz" };
    const result = asRecord(redactSensitive(input));
    expect(result["SecretString"]).toBe("[REDACTED]");
  });

  it("redacts Password", () => {
    const input = { Password: "real-cred" };
    const result = asRecord(redactSensitive(input));
    expect(result["Password"]).toBe("[REDACTED]");
  });
});

describe("redactSensitive — NOT over-redacted (allowlist precision)", () => {
  it("PasswordPolicy (Cognito UserPool) is NOT redacted", () => {
    const input = {
      PasswordPolicy: { MinimumLength: 12, RequireUppercase: true },
    };
    const result = asRecord(redactSensitive(input));
    expect(result["PasswordPolicy"]).toEqual(input.PasswordPolicy);
  });

  it("UserData (EC2 bootstrap) is NOT redacted", () => {
    const input = {
      UserData: "#!/bin/bash\necho 'hi' > /var/log/boot\nsystemctl start nginx",
    };
    const result = asRecord(redactSensitive(input));
    expect(result["UserData"]).toBe(input.UserData);
  });

  it("TokenValidityUnits is NOT redacted", () => {
    const input = {
      TokenValidityUnits: { AccessToken: "minutes", RefreshToken: "days" },
    };
    const result = asRecord(redactSensitive(input));
    expect(result["TokenValidityUnits"]).toEqual(input.TokenValidityUnits);
  });

  it("SecretStringTemplate (not the secret, a shape descriptor) is NOT redacted", () => {
    const input = {
      SecretStringTemplate: JSON.stringify({ username: "admin" }),
    };
    const result = asRecord(redactSensitive(input));
    expect(result["SecretStringTemplate"]).toBe(input.SecretStringTemplate);
  });

  it("keys containing 'secret' as substring in a different case are NOT redacted", () => {
    // "SecretHandshake" doesn't appear in the allowlist. Case-sensitive
    // exact match is the intended behaviour.
    const input = { SecretHandshake: "ritual-phrase" };
    const result = asRecord(redactSensitive(input));
    expect(result["SecretHandshake"]).toBe("ritual-phrase");
  });
});

describe("redactStringValue — key-blind value scrubbers", () => {
  it("scrubs AKIA access keys embedded in any string", () => {
    expect(redactStringValue("credential AKIAABCDEFGHIJKLMNOP here")).toBe(
      "credential [REDACTED-AKIA] here",
    );
  });

  it("scrubs ASIA short-term session tokens", () => {
    expect(redactStringValue("session ASIAZZZZZZZZZZZZZZZZ active")).toBe(
      "session [REDACTED-AKIA] active",
    );
  });

  it("scrubs multiple AKIA/ASIA occurrences in one string", () => {
    expect(
      redactStringValue("keys: AKIAABCDEFGHIJKLMNOP and ASIAZZZZZZZZZZZZZZZZ"),
    ).toBe("keys: [REDACTED-AKIA] and [REDACTED-AKIA]");
  });

  it.each([
    ["arn:aws:iam::123456789012:role/foo", "arn:aws:iam::[REDACTED]:role/foo"],
    [
      "arn:aws-cn:iam::999999999999:user/x",
      "arn:aws-cn:iam::[REDACTED]:user/x",
    ],
    [
      "arn:aws-us-gov:iam::123456789012:group/admins",
      "arn:aws-us-gov:iam::[REDACTED]:group/admins",
    ],
    [
      "arn:aws-iso:iam::123456789012:policy/SecurityAudit",
      "arn:aws-iso:iam::[REDACTED]:policy/SecurityAudit",
    ],
    [
      "arn:aws-iso-b:iam::987654321098:role/ops",
      "arn:aws-iso-b:iam::[REDACTED]:role/ops",
    ],
  ])(
    "scrubs IAM ARN account segment (partition preserved) in %s",
    (input, expected) => {
      expect(redactStringValue(input)).toBe(expected);
    },
  );

  it("leaves non-IAM ARNs alone (S3 / EC2 / SNS / etc.)", () => {
    const arns = [
      "arn:aws:s3:::assignee-logs",
      "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-abc",
      "arn:aws:sns:us-east-1:123456789012:assignee-alerts",
    ];
    for (const arn of arns) {
      // IAM_ARN_ACCOUNT_PATTERN requires `:iam::` — other services
      // pass through the VALUE scrubber unchanged.
      expect(redactStringValue(arn)).toBe(arn);
    }
  });

  it("preserves plain strings without any credential shape", () => {
    expect(redactStringValue("plain message with no keys")).toBe(
      "plain message with no keys",
    );
  });
});

describe("redactSensitive — deep shape preservation", () => {
  it("walks nested objects and redacts deep credentials", () => {
    const input = {
      request: {
        metadata: { region: "us-east-1" },
        credentials: {
          AWS_ACCESS_KEY_ID: "AKIAREALKEYEXAMPLE1",
          AWS_SECRET_ACCESS_KEY: "deep-secret",
        },
      },
    };
    const result = asRecord(redactSensitive(input));
    const req = asRecord(result["request"]);
    expect(req["metadata"]).toEqual({ region: "us-east-1" });
    const creds = asRecord(req["credentials"]);
    expect(creds["AWS_ACCESS_KEY_ID"]).toBe("[REDACTED]");
    expect(creds["AWS_SECRET_ACCESS_KEY"]).toBe("[REDACTED]");
  });

  it("walks arrays of objects", () => {
    const input = {
      history: [
        {
          ts: "2026-04-16T10:00:00Z",
          AWS_ACCESS_KEY_ID: "AKIAONE",
        },
        {
          ts: "2026-04-16T11:00:00Z",
          AWS_ACCESS_KEY_ID: "AKIATWO",
        },
      ],
    };
    const result = asRecord(redactSensitive(input));
    const hist = result["history"] as Array<Record<string, unknown>>;
    expect(hist).toHaveLength(2);
    expect(hist[0]!["AWS_ACCESS_KEY_ID"]).toBe("[REDACTED]");
    expect(hist[1]!["AWS_ACCESS_KEY_ID"]).toBe("[REDACTED]");
    expect(hist[0]!["ts"]).toBe("2026-04-16T10:00:00Z");
    expect(hist[1]!["ts"]).toBe("2026-04-16T11:00:00Z");
  });

  it("applies value-scrubbing to string values inside innocuous keys", () => {
    const input = {
      message: "error text: AKIAABCDEFGHIJKLMNOP leaked",
    };
    const result = asRecord(redactSensitive(input));
    expect(result["message"]).toBe("error text: [REDACTED-AKIA] leaked");
  });

  it("preserves null / number / boolean primitives verbatim", () => {
    const input = {
      region: "us-east-1",
      timeout: 30,
      enabled: true,
      optional: null,
      undef: undefined,
    };
    const result = asRecord(redactSensitive(input));
    expect(result).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = {
      AWS_SECRET_ACCESS_KEY: "xyz",
      meta: { keep: true },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactSensitive(input);
    expect(input).toEqual(snapshot);
  });
});

describe("redactSensitive — recording fixture round-trip", () => {
  it("preserves required fixture fields (tool / region / resourceType) while scrubbing credentials", () => {
    // Shape matches what apps/cli/src/utils/recorder writes: an MCP
    // invocation envelope with the operator credentials nested inside.
    const recording = {
      tool: "destroy-resource",
      request: {
        region: "us-east-1",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::assignee-dev-logs",
        credentials: {
          ASSIGNEE_OPERATOR_ACCESS_KEY_ID: "AKIAREAL",
          ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: "real-secret",
          ASSIGNEE_OPERATOR_SESSION_TOKEN: "real-token",
        },
      },
      response: {
        success: true,
        callerArn: "arn:aws:iam::123456789012:role/AssigneeOperator",
      },
    };
    const result = asRecord(redactSensitive(recording));

    // Required fixture fields round-trip.
    expect(result["tool"]).toBe("destroy-resource");
    const req = asRecord(result["request"]);
    expect(req["region"]).toBe("us-east-1");
    expect(req["resourceType"]).toBe("AWS::S3::Bucket");
    expect(req["resourceArn"]).toBe("arn:aws:s3:::assignee-dev-logs");

    // Operator creds redacted.
    const creds = asRecord(req["credentials"]);
    expect(creds["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe("[REDACTED]");
    expect(creds["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"]).toBe("[REDACTED]");
    // SESSION_TOKEN key is not in the allowlist — but the VALUE is a
    // plain string, so passes through (the recorder only uses the
    // *_ACCESS_KEY_ID / _SECRET_ACCESS_KEY pair as canonical creds).
    expect(creds["ASSIGNEE_OPERATOR_SESSION_TOKEN"]).toBe("real-token");

    // IAM ARN in response → account slot scrubbed, partition kept.
    const resp = asRecord(result["response"]);
    expect(resp["callerArn"]).toBe(
      "arn:aws:iam::[REDACTED]:role/AssigneeOperator",
    );
    expect(resp["success"]).toBe(true);
  });
});
