/**
 * Dedicated unit tests for error-message redaction (Story 50-6).
 *
 * `redactSensitive` scrubs 12-digit AWS account IDs and full ARNs from
 * error messages before they are displayed or logged. Partition-aware
 * per feedback_partition_aware_arn_matching — covers aws, aws-cn,
 * aws-us-gov, aws-iso, aws-iso-b.
 *
 * Order matters: ARNs are replaced first (because they CONTAIN account
 * IDs), then bare account IDs are scrubbed. The tests pin:
 *
 *   - Bare 12-digit account ID → `[ACCOUNT]`
 *   - ARN containing account ID → `[ARN]` (ARN wins; the account slot
 *     inside never leaks as a bare number).
 *   - All 5 partitions produce identical redaction output.
 *   - Bedrock foundation-model ARN is ALSO caught by the ARN pattern
 *     (safe — it has no PII; slight over-redaction is fine).
 *   - Multi-line error messages are scrubbed across newlines.
 *   - Non-matches (empty string, undefined-coerced to empty, message
 *     with no identifiers) pass through unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  redactSensitive,
  redactAccountIdsInPrompt,
  stripSensitiveFromElicited,
  buildSensitiveFieldSet,
  ELICITED_REDACTED_VALUE,
} from "./redact.js";
import type { ResourceField } from "../resource-plugins/types.js";

describe("redactSensitive — bare account IDs", () => {
  it("replaces a bare 12-digit account ID with [ACCOUNT]", () => {
    expect(
      redactSensitive("Access denied for account 123456789012 on S3"),
    ).toBe("Access denied for account [ACCOUNT] on S3");
  });

  it("replaces every occurrence in a single string", () => {
    expect(
      redactSensitive(
        "source=123456789012 target=987654321098 requester=555555555555",
      ),
    ).toBe("source=[ACCOUNT] target=[ACCOUNT] requester=[ACCOUNT]");
  });

  it("leaves 11-digit numbers alone (below the word boundary threshold)", () => {
    expect(redactSensitive("id=12345678901 is an 11-digit number")).toBe(
      "id=12345678901 is an 11-digit number",
    );
  });

  it("leaves 13-digit numbers alone", () => {
    // \b\d{12}\b requires EXACTLY 12 digits with word boundaries — a
    // 13-digit number is not a match at either boundary.
    expect(redactSensitive("value=1234567890123 too long")).toBe(
      "value=1234567890123 too long",
    );
  });
});

describe("redactSensitive — ARN-aware replacement (partitions)", () => {
  const cases: Array<[string, string]> = [
    ["arn:aws:iam::123456789012:role/assignee-operator", "commercial IAM role"],
    ["arn:aws-us-gov:iam::123456789012:role/gov-role", "GovCloud IAM role"],
    [
      "arn:aws-cn:sns:cn-north-1:123456789012:assignee-alerts",
      "China SNS topic",
    ],
    ["arn:aws-iso:kms:us-iso-east-1:123456789012:key/abcd-1234", "ISO KMS key"],
    [
      "arn:aws-iso-b:lambda:us-isob-east-1:123456789012:function:fn",
      "ISO-B Lambda function",
    ],
  ];

  it.each(cases)("replaces %s (%s) with [ARN]", (arn) => {
    const message = `Caller has no permission on ${arn}`;
    const result = redactSensitive(message);
    expect(result).toBe("Caller has no permission on [ARN]");
    // The 12-digit account segment MUST NOT leak: check the raw output.
    expect(result).not.toContain("123456789012");
  });
});

describe("redactSensitive — ARN + bare account ID mixed", () => {
  it("redacts ARN first, THEN sweeps remaining bare accounts", () => {
    // The ARN pattern ends with `[^\\s]*` (greedy to whitespace), so
    // any trailing punctuation attached to the ARN without a space
    // gets consumed into the [ARN] token — intentional: a redacted
    // error message must not leak account digits, and swallowing
    // trailing "." / "," is acceptable collateral.
    const input =
      "Primary: arn:aws:iam::123456789012:role/X Secondary: 987654321098";
    expect(redactSensitive(input)).toBe("Primary: [ARN] Secondary: [ACCOUNT]");
  });

  it("ARN with trailing punctuation — punctuation is consumed into [ARN] (documented greedy behaviour)", () => {
    const input =
      "Primary: arn:aws:iam::123456789012:role/X. Secondary: 987654321098";
    // Trailing '.' gets eaten because [^\s]* matches until whitespace.
    expect(redactSensitive(input)).toBe("Primary: [ARN] Secondary: [ACCOUNT]");
  });

  it("an ARN with no account segment is still caught (but the account-id sweep has nothing left to do)", () => {
    // aws:s3:::<bucket> has no account slot. Still matches the ARN
    // pattern? Check the source: ARN_PATTERN uses [a-z0-9-]+:[a-z0-9-]*:\\d{12}:
    // — it REQUIRES a 12-digit account. An S3 bucket ARN has no
    // digits in that slot so it should NOT match the ARN pattern.
    const input = "bucket arn:aws:s3:::assignee-logs is public";
    const result = redactSensitive(input);
    expect(result).toBe(input); // no change
  });
});

describe("redactSensitive — multi-line messages", () => {
  it("redacts across newline boundaries", () => {
    const input = [
      "Operation failed:",
      "  Principal: arn:aws:iam::123456789012:role/A",
      "  Target:    arn:aws-us-gov:iam::210987654321:role/B",
      "  Account:   210987654321",
    ].join("\n");
    const result = redactSensitive(input);
    expect(result).toBe(
      [
        "Operation failed:",
        "  Principal: [ARN]",
        "  Target:    [ARN]",
        "  Account:   [ACCOUNT]",
      ].join("\n"),
    );
  });
});

describe("redactSensitive — non-matches", () => {
  it("empty string passes through", () => {
    expect(redactSensitive("")).toBe("");
  });

  it("message with no ARN and no 12-digit number passes through", () => {
    const msg = "Rate exceeded — please retry in a few seconds.";
    expect(redactSensitive(msg)).toBe(msg);
  });

  it("ARNs with tabs or no space boundary still get redacted up to whitespace", () => {
    // Pattern is `[^\\s]*` — greedy-ish until a space. Two ARNs
    // separated by a tab each land in [ARN] independently.
    const input = "arn:aws:iam::123456789012:role/A\tarn:aws-cn:s3:::b";
    const result = redactSensitive(input);
    // First ARN consumed greedily until whitespace → [ARN].
    // Second is arn:aws-cn:s3:::b — no 12-digit account → not matched
    // by the ARN pattern but also doesn't contain a bare 12-digit
    // number, so it passes through.
    expect(result).toBe("[ARN]\tarn:aws-cn:s3:::b");
  });
});

describe("redactSensitive — Bedrock model ARN (allowed visibility)", () => {
  // Bedrock foundation-model ARNs are not PII and deliberately passed
  // through unchanged UNLESS they happen to contain an account-id slot.
  // In practice, foundation-model ARNs have an EMPTY account slot
  // (arn:aws:bedrock:<region>::foundation-model/<model-id>) so the
  // ARN_PATTERN requiring `\\d{12}` does NOT match them.
  it("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-... passes through", () => {
    const input =
      "Using arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-v1:0";
    expect(redactSensitive(input)).toBe(input);
  });

  it("GovCloud Bedrock model ARN also passes through", () => {
    const input =
      "model: arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/amazon.nova-lite-v1:0";
    expect(redactSensitive(input)).toBe(input);
  });
});

// Epic 92 u.e (D-27) — ARN-preserving account-only redaction.
// The LLM adapter uses this helper so the plan table can still show
// `TopicArn: arn:aws:sns:us-east-1:[ACCOUNT]:my-topic` instead of
// `TopicArn: [ARN]` — user can verify the target, account is scrubbed.
describe("redactAccountIdsInPrompt — preserves ARN skeleton, scrubs account slot", () => {
  it("replaces the 12-digit account slot in a full IAM ARN", () => {
    expect(
      redactAccountIdsInPrompt(
        "use arn:aws:iam::123456789012:role/assignee-operator for the lambda",
      ),
    ).toBe("use arn:aws:iam::[ACCOUNT]:role/assignee-operator for the lambda");
  });

  it("replaces the account slot in an SNS topic ARN (D-27 canonical case)", () => {
    expect(
      redactAccountIdsInPrompt(
        "subscribe to arn:aws:sns:us-east-1:123456789012:my-orders-topic",
      ),
    ).toBe("subscribe to arn:aws:sns:us-east-1:[ACCOUNT]:my-orders-topic");
  });

  it("handles multiple ARNs in one string", () => {
    expect(
      redactAccountIdsInPrompt(
        "role arn:aws:iam::210987654321:role/A and queue arn:aws:sqs:us-east-1:109876543210:queue-b",
      ),
    ).toBe(
      "role arn:aws:iam::[ACCOUNT]:role/A and queue arn:aws:sqs:us-east-1:[ACCOUNT]:queue-b",
    );
  });

  it("partition-aware: GovCloud ARN account slot scrubbed", () => {
    expect(
      redactAccountIdsInPrompt(
        "operator arn:aws-us-gov:iam::123456789012:role/gov-ops",
      ),
    ).toBe("operator arn:aws-us-gov:iam::[ACCOUNT]:role/gov-ops");
  });

  it("partition-aware: China-partition ARN account slot scrubbed", () => {
    expect(
      redactAccountIdsInPrompt(
        "alerts arn:aws-cn:sns:cn-north-1:123456789012:alerts",
      ),
    ).toBe("alerts arn:aws-cn:sns:cn-north-1:[ACCOUNT]:alerts");
  });

  it("sweeps bare 12-digit account IDs that are NOT part of an ARN", () => {
    expect(
      redactAccountIdsInPrompt(
        "caller account 123456789012 is not the same as 987654321098",
      ),
    ).toBe("caller account [ACCOUNT] is not the same as [ACCOUNT]");
  });

  it("mixed: ARN + bare account ID — both scrubbed, skeleton preserved", () => {
    expect(
      redactAccountIdsInPrompt(
        "Primary: arn:aws:iam::123456789012:role/X cross-account target 987654321098",
      ),
    ).toBe(
      "Primary: arn:aws:iam::[ACCOUNT]:role/X cross-account target [ACCOUNT]",
    );
  });

  it("clean prompt (no ARN, no 12-digit number) passes through unchanged", () => {
    const msg = "Create a t3.micro EC2 in us-east-1";
    expect(redactAccountIdsInPrompt(msg)).toBe(msg);
  });

  it("S3 bucket ARN (no account slot) passes through — nothing to scrub", () => {
    const msg = "bucket arn:aws:s3:::assignee-logs";
    expect(redactAccountIdsInPrompt(msg)).toBe(msg);
  });

  it("Bedrock foundation-model ARN (empty account slot) passes through", () => {
    const msg =
      "Using arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-v1:0";
    expect(redactAccountIdsInPrompt(msg)).toBe(msg);
  });

  it("empty string passes through", () => {
    expect(redactAccountIdsInPrompt("")).toBe("");
  });

  it("never leaks account digits — invariant under every partition", () => {
    const partitions = [
      "aws",
      "aws-cn",
      "aws-us-gov",
      "aws-iso",
      "aws-iso-b",
    ] as const;
    for (const p of partitions) {
      const input = `token arn:${p}:sns:us-east-1:123456789012:topic suffix`;
      const out = redactAccountIdsInPrompt(input);
      expect(out).not.toContain("123456789012");
      expect(out).toContain("[ACCOUNT]");
      expect(out).toContain(p);
      expect(out).toContain("topic");
    }
  });
});

// ── SEC-007: Multi-provider secret pattern coverage ───────────────────────────
//
// Each sub-suite uses a real-shaped example value (matching the provider's
// documented format) plus a canary that must not appear in the output.
// For the JWT suite, a synthetic header.payload.signature triple is used.

describe("redactSensitive — Anthropic API key (SEC-007)", () => {
  it("redacts a legacy sk-ant-... key embedded in an error message", () => {
    const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAABBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const input = `Authentication failed: invalid key ${key} check your credentials`;
    const result = redactSensitive(input);
    expect(result).toContain("[ANTHROPIC_KEY]");
    expect(result).not.toContain(key);
  });

  it("redacts a standalone Anthropic key (no surrounding context)", () => {
    const key =
      "sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    expect(redactSensitive(key)).toBe("[ANTHROPIC_KEY]");
  });

  it("does not affect unrelated sk- prefixed strings shorter than the pattern", () => {
    // Generic "sk-" without the "ant-" sub-prefix must NOT be matched.
    const safe = "sk-short";
    expect(redactSensitive(safe)).toBe(safe);
  });
});

describe("redactSensitive — OpenAI key (SEC-007)", () => {
  it("redacts an sk-proj-... project key", () => {
    const key = "sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL";
    const input = `API call failed with key=${key}`;
    const result = redactSensitive(input);
    expect(result).toContain("[OPENAI_KEY]");
    expect(result).not.toContain(key);
  });

  it("does not match bare sk- without a recognised sub-prefix", () => {
    // Legacy OpenAI keys (sk-<48 chars> without sub-prefix) are intentionally
    // not matched because the shape overlaps too broadly with other tokens.
    const safe = "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(redactSensitive(safe)).toBe(safe);
  });
});

describe("redactSensitive — GitHub token (SEC-007)", () => {
  it("redacts a classic PAT (ghp_...)", () => {
    const token = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234";
    const input = `Authorization: Bearer ${token}`;
    const result = redactSensitive(input);
    expect(result).toContain("[GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });

  it("redacts an OAuth token (gho_...)", () => {
    const token = "gho_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB5678";
    const result = redactSensitive(`clone with ${token} failed`);
    expect(result).toContain("[GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });

  it("redacts a fine-grained PAT (github_pat_...)", () => {
    const token = "github_pat_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC9012";
    const result = redactSensitive(`token=${token}`);
    expect(result).toContain("[GITHUB_TOKEN]");
    expect(result).not.toContain(token);
  });
});

describe("redactSensitive — Slack token (SEC-007)", () => {
  it("redacts a bot token (xoxb-...)", () => {
    const token = "xoxb-1234567890-12345678901-abcdefghijklmnopqrst";
    const result = redactSensitive(`slack error token=${token}`);
    expect(result).toContain("[SLACK_TOKEN]");
    expect(result).not.toContain(token);
  });

  it("redacts a user token (xoxp-...)", () => {
    const token = "xoxp-9876543210-98765432101-zyxwvutsrqponmlkjihg";
    const result = redactSensitive(`xoxp token: ${token}`);
    expect(result).toContain("[SLACK_TOKEN]");
    expect(result).not.toContain(token);
  });
});

describe("redactSensitive — Google AI key (SEC-007)", () => {
  it("redacts a Google AI API key (AIza + 35 chars)", () => {
    const key = "AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1";
    const input = `Google key=${key} rejected`;
    const result = redactSensitive(input);
    expect(result).toContain("[GOOGLE_KEY]");
    expect(result).not.toContain(key);
  });

  it("does not false-positive on AIza with fewer than 35 trailing chars", () => {
    // Pattern requires exactly 35 chars after AIza.
    const short = "AIzaShort";
    expect(redactSensitive(short)).toBe(short);
  });
});

describe("redactSensitive — JWT (SEC-007)", () => {
  it("redacts a three-part JWT (header.payload.signature)", () => {
    // Real-shaped: base64url-encoded header + payload + signature separated by dots.
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ" +
      ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `bearer ${jwt} expired`;
    const result = redactSensitive(input);
    expect(result).toContain("[JWT]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("redacts a two-part JWT (header.payload without signature)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
    const result = redactSensitive(`token=${jwt}`);
    expect(result).toContain("[JWT]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("does not false-positive on bare eyJ prefix without a dot separator", () => {
    // Pattern requires at least one dot separator to avoid false-positives
    // on short base64 strings that happen to start with eyJ.
    const safe = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    expect(redactSensitive(safe)).toBe(safe);
  });
});

// ── W1-01 (Epic 100): stripSensitiveFromElicited ──────────────────────────────
//
// Covers all acceptance-criteria cases:
//   - Empty record
//   - No sensitive fields (passthrough)
//   - One sensitive field (redacted)
//   - Mixed sensitive + non-sensitive fields
//   - buildSensitiveFieldSet helper
//   - Returns a new object (no mutation)
//
// The test strings "secret-canary-12345" are the canary credential strings
// referenced in the story spec.

describe("buildSensitiveFieldSet", () => {
  const makeField = (name: string, sensitive?: boolean): ResourceField => ({
    name,
    question: { type: "string", label: name },
    sensitive,
  });

  it("returns empty set when no fields are sensitive", () => {
    const fields = [makeField("DBName"), makeField("Engine")];
    const set = buildSensitiveFieldSet(fields);
    expect(set.size).toBe(0);
  });

  it("includes only fields with sensitive: true", () => {
    const fields = [
      makeField("DBName"),
      makeField("MasterUserPassword", true),
      makeField("Engine"),
      makeField("SecretString", true),
    ];
    const set = buildSensitiveFieldSet(fields);
    expect(set.size).toBe(2);
    expect(set.has("MasterUserPassword")).toBe(true);
    expect(set.has("SecretString")).toBe(true);
    expect(set.has("DBName")).toBe(false);
    expect(set.has("Engine")).toBe(false);
  });

  it("treats sensitive: false the same as absent (not included)", () => {
    const fields = [makeField("Foo", false), makeField("Bar")];
    const set = buildSensitiveFieldSet(fields);
    expect(set.size).toBe(0);
  });

  it("handles empty field list", () => {
    expect(buildSensitiveFieldSet([]).size).toBe(0);
  });
});

describe("stripSensitiveFromElicited", () => {
  const noSensitiveNames = new Set<string>();
  const withPassword = new Set(["MasterUserPassword"]);
  const multiSensitive = new Set(["MasterUserPassword", "SecretString"]);

  it("returns empty object when input is empty", () => {
    expect(stripSensitiveFromElicited({}, noSensitiveNames)).toEqual({});
    expect(stripSensitiveFromElicited({}, withPassword)).toEqual({});
  });

  it("passes through a record with no sensitive fields unchanged", () => {
    const input = {
      DBName: "myapp",
      Engine: "postgres",
      MultiAZ: false,
    };
    const result = stripSensitiveFromElicited(input, noSensitiveNames);
    expect(result).toEqual(input);
    // Verify it's a new object, not the same reference
    expect(result).not.toBe(input);
  });

  it("passes through record when sensitiveNames set is empty", () => {
    const input = {
      DBName: "myapp",
      MasterUserPassword: "secret-canary-12345",
    };
    const result = stripSensitiveFromElicited(input, noSensitiveNames);
    // Without any names in the set, nothing is scrubbed
    expect(result["MasterUserPassword"]).toBe("secret-canary-12345");
  });

  it("redacts a single sensitive field value", () => {
    const input = {
      MasterUserPassword: "secret-canary-12345",
    };
    const result = stripSensitiveFromElicited(input, withPassword);
    expect(result["MasterUserPassword"]).toBe(ELICITED_REDACTED_VALUE);
    expect(result["MasterUserPassword"]).not.toContain("secret-canary-12345");
  });

  it("redacts only the sensitive fields in a mixed record", () => {
    const input = {
      DBName: "myapp",
      Engine: "postgres",
      MasterUsername: "appuser",
      MasterUserPassword: "secret-canary-12345",
    };
    const result = stripSensitiveFromElicited(input, withPassword);
    // Sensitive field is redacted
    expect(result["MasterUserPassword"]).toBe(ELICITED_REDACTED_VALUE);
    // Non-sensitive fields pass through unchanged
    expect(result["DBName"]).toBe("myapp");
    expect(result["Engine"]).toBe("postgres");
    expect(result["MasterUsername"]).toBe("appuser");
    // Canary must not appear anywhere in the result
    expect(JSON.stringify(result)).not.toContain("secret-canary-12345");
  });

  it("redacts multiple sensitive fields simultaneously", () => {
    const input = {
      Name: "my-secret",
      Description: "Production credentials",
      SecretString: "secret-canary-12345",
      MasterUserPassword: "another-secret-canary-67890",
      Tags: "env:prod",
    };
    const result = stripSensitiveFromElicited(input, multiSensitive);
    expect(result["SecretString"]).toBe(ELICITED_REDACTED_VALUE);
    expect(result["MasterUserPassword"]).toBe(ELICITED_REDACTED_VALUE);
    expect(result["Name"]).toBe("my-secret");
    expect(result["Description"]).toBe("Production credentials");
    expect(result["Tags"]).toBe("env:prod");
    // Neither canary string should survive
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-canary-12345");
    expect(serialized).not.toContain("another-secret-canary-67890");
  });

  it("does not mutate the input object", () => {
    const input = { MasterUserPassword: "secret-canary-12345" };
    const frozen = Object.freeze({ ...input });
    expect(() =>
      stripSensitiveFromElicited(frozen, withPassword),
    ).not.toThrow();
    // Original value preserved
    expect(frozen.MasterUserPassword).toBe("secret-canary-12345");
  });

  it("preserves non-string values (booleans, numbers, null, arrays) for non-sensitive fields", () => {
    const input = {
      MultiAZ: false,
      Port: 5432,
      Tags: null,
      AllowedValues: ["a", "b"],
    };
    const result = stripSensitiveFromElicited(input, noSensitiveNames);
    expect(result["MultiAZ"]).toBe(false);
    expect(result["Port"]).toBe(5432);
    expect(result["Tags"]).toBeNull();
    expect(result["AllowedValues"]).toEqual(["a", "b"]);
  });

  it("ELICITED_REDACTED_VALUE is the string literal '[REDACTED]'", () => {
    expect(ELICITED_REDACTED_VALUE).toBe("[REDACTED]");
  });
});

// ── SEC-025: partition-aware ARN redaction — stderr boundary ─────────────
// Regression test: confirms that `redactSensitive` (the function called on
// every `mcpLogError` message before it reaches stderr) correctly scrubs ARNs
// from ALL five AWS partitions. Treat stderr as a redaction boundary — each
// partition variant of a sensitive ARN MUST be replaced with [ARN].
describe("redactSensitive — SEC-025 stderr/mcpLogError partition coverage", () => {
  const partitionCases: Array<[string, string]> = [
    ["aws", "arn:aws:iam::123456789012:role/assignee-operator"],
    ["aws-cn", "arn:aws-cn:iam::123456789012:role/assignee-operator"],
    ["aws-us-gov", "arn:aws-us-gov:iam::123456789012:role/gov-role"],
    ["aws-iso", "arn:aws-iso:kms:us-iso-east-1:123456789012:key/abcd-1234"],
    [
      "aws-iso-b",
      "arn:aws-iso-b:lambda:us-isob-east-1:123456789012:function:fn",
    ],
  ];

  it.each(partitionCases)(
    "partition '%s' ARN is redacted (as if routed through mcpLogError message)",
    (partition, arn) => {
      // Simulate what mcpLogError does: pass err.message through redactSensitive
      // before writing to stderr. The result must not contain the raw ARN or
      // the embedded 12-digit account ID.
      const errMsg = `AccessDenied for principal ${arn} on resource s3:::bucket`;
      const redacted = redactSensitive(errMsg);
      expect(redacted).toContain("[ARN]");
      expect(redacted).not.toContain(arn);
      expect(redacted).not.toContain("123456789012");
      // Partition name must NOT leak either (it's absorbed into [ARN]).
      void partition; // partition is checked implicitly via arn shape
    },
  );
});
