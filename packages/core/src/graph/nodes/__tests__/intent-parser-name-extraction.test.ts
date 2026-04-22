/**
 * Epic 94 Wave 1 fixer e94.R8 — intent-parser multi-word / unicode name
 * extraction.
 *
 * Closes A-05 (HIGH REGRESSION) + A-06 (MED REGRESSION). The previous
 * extractor regex `/\b(?:named|called)\s+['"]?([A-Za-z][A-Za-z0-9_-]{0,63})\b/`
 * silently:
 *
 *   - A-05: pre-truncated unicode names (`dögfood-ünicode` → `d`) so
 *     R1's `validateDesiredStateNode` could not surface the real
 *     non-ASCII error to the user.
 *   - A-06: dropped trailing tokens on multi-word names
 *     (`bad bucket name` → `bad`) with no user-visible signal.
 *
 * These tests lock in the new contract:
 *   1. Unicode → INVALID_NAME error via `errors[]`, no `elicited`
 *      write so the validator does not see a mangled value.
 *   2. Multi-word (unquoted) → captures the leading token AND emits a
 *      structured `NAME_REMAINDER_IGNORED` advisory with the ignored
 *      tail reported verbatim.
 *   3. Quoted span → whitespace preserved, no advisory.
 *   4. Single-word ASCII → captured, no advisory, no error (no
 *      regression).
 *   5. Directive boundary (`with`, `for`, …) terminates capture so
 *      configuration clauses are not mis-reported as remainders.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { extractAssertedValues } from "../intent-parser.js";

describe("extractAssertedValues — resource-name extractor (e94.R8)", () => {
  describe("A-05: unicode rejection", () => {
    it("rejects non-ASCII name `dögfood-ünicode` with INVALID_NAME error", () => {
      const { elicited, errors } = extractAssertedValues(
        "Create an S3 bucket named dögfood-ünicode",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors.length).toBeGreaterThanOrEqual(1);
      const combined = errors.join(" ");
      expect(combined).toMatch(/non-ASCII/i);
      // No silently-truncated value on `elicited` — the validator must
      // never see `d` and think the user wanted a 1-char bucket name.
      expect(elicited["BucketName"]).toBeUndefined();
    });

    it("rejects non-ASCII inside the middle of the token", () => {
      const { elicited, errors } = extractAssertedValues(
        "Create an S3 bucket named foo-ü-bar",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.join(" ")).toMatch(/non-ASCII/i);
      expect(elicited["BucketName"]).toBeUndefined();
    });

    it("rejects non-ASCII name for Lambda (rule is universal, not S3-specific)", () => {
      // Lambda also forbids non-ASCII in FunctionName — the error path
      // is generic so every supported resource type benefits.
      const { elicited, errors } = extractAssertedValues(
        "Create a lambda named föö-bar",
        RESOURCE_TYPES.LAMBDA_FUNCTION,
      );

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.join(" ")).toMatch(/non-ASCII|ASCII/i);
      expect(elicited["FunctionName"]).toBeUndefined();
    });
  });

  describe("A-06: multi-word remainder advisory", () => {
    it("captures leading token and emits NAME_REMAINDER_IGNORED for `bad bucket name`", () => {
      const { elicited, errors, advisories } = extractAssertedValues(
        "Create an S3 bucket named bad bucket name",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors).toEqual([]);
      // Leading ASCII token survived and landed on BucketName.
      expect(elicited["BucketName"]).toBe("bad");
      // Advisory reports the ignored tail verbatim.
      const nameAdvisory = advisories.find(
        (a) => a.code === "NAME_REMAINDER_IGNORED",
      );
      expect(nameAdvisory).toBeDefined();
      expect(nameAdvisory!.message).toContain("bucket name");
      expect(nameAdvisory!.message).toContain("bad");
      // Hint offers two actionable alternatives: quotes or hyphens.
      expect(nameAdvisory!.hint).toMatch(/quote|hyphen/i);
    });

    it("emits advisory even when the remainder is a single extra word", () => {
      const { advisories, elicited } = extractAssertedValues(
        "Create an S3 bucket named foo bar",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("foo");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        true,
      );
    });

    it("maps the remainder advisory through to Lambda too", () => {
      const { advisories, elicited } = extractAssertedValues(
        "Create a lambda named my cool function thing",
        RESOURCE_TYPES.LAMBDA_FUNCTION,
      );

      expect(elicited["FunctionName"]).toBe("my");
      const adv = advisories.find((a) => a.code === "NAME_REMAINDER_IGNORED");
      expect(adv).toBeDefined();
      // "cool function thing" — but `function` is a name-boundary
      // keyword, so the advisory should report the pre-boundary portion
      // only. That's still `cool`, which is non-empty → advisory fires.
      expect(adv!.message).toContain("cool");
    });
  });

  describe("quoted spans preserve spaces", () => {
    it('`named "my fun bucket"` → BucketName contains spaces, no advisory', () => {
      const { elicited, errors, advisories } = extractAssertedValues(
        'Create an S3 bucket named "my fun bucket"',
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors).toEqual([]);
      expect(elicited["BucketName"]).toBe("my fun bucket");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });

    it("single-quoted form also honoured", () => {
      const { elicited, advisories } = extractAssertedValues(
        "Create an S3 bucket named 'another bucket'",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("another bucket");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });
  });

  describe("baseline — single-word ASCII names (no regression)", () => {
    it("`named app-logs` → BucketName set, no advisory, no error", () => {
      const { elicited, errors, advisories } = extractAssertedValues(
        "Create an S3 bucket named app-logs",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors).toEqual([]);
      expect(elicited["BucketName"]).toBe("app-logs");
      expect(advisories).toEqual([]);
    });

    it("`called my-queue` → QueueName on SQS", () => {
      const { elicited } = extractAssertedValues(
        "Create an SQS queue called my-queue",
        RESOURCE_TYPES.SQS_QUEUE,
      );

      expect(elicited["QueueName"]).toBe("my-queue");
    });
  });

  describe("directive boundary keywords terminate capture", () => {
    it("`named app-logs with versioning` → BucketName `app-logs`, no advisory", () => {
      // "with versioning" is a configuration clause, not a dropped
      // name remainder. The extractor must recognise `with` as a
      // boundary keyword and not mis-report the clause.
      const { elicited, advisories } = extractAssertedValues(
        "Create an S3 bucket named app-logs with versioning",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("app-logs");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });

    it("`named my-bucket in us-east-1` → no advisory", () => {
      const { elicited, advisories } = extractAssertedValues(
        "Create an S3 bucket named my-bucket in us-east-1",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("my-bucket");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });

    it("`named my-bucket for the web tier` → no advisory (`for` boundary)", () => {
      const { elicited, advisories } = extractAssertedValues(
        "Create an S3 bucket named my-bucket for the web tier",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("my-bucket");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });

    it("punctuation `.` terminates the span", () => {
      const { elicited, advisories } = extractAssertedValues(
        "Create an S3 bucket named my-bucket. It should be encrypted.",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(elicited["BucketName"]).toBe("my-bucket");
      expect(advisories.some((a) => a.code === "NAME_REMAINDER_IGNORED")).toBe(
        false,
      );
    });
  });

  describe("no-op when clause is absent", () => {
    it("intent without `named`/`called` → no error, no advisory, no elicited name", () => {
      const { elicited, errors, advisories } = extractAssertedValues(
        "Create an S3 bucket",
        RESOURCE_TYPES.S3_BUCKET,
      );

      expect(errors).toEqual([]);
      expect(advisories).toEqual([]);
      expect(elicited["BucketName"]).toBeUndefined();
    });
  });
});
