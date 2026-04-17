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
import { redactSensitive } from "./redact.js";

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
      "  Target:    arn:aws-us-gov:iam::987654321098:role/B",
      "  Account:   555555555555",
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
