/**
 * W6-04 unit tests for the OTEL source-side allowlist and field
 * classification / PII filter.
 *
 * Acceptance criteria verified:
 *   - PII field emitted with default exporter → stripped
 *   - PII field emitted with ASSIGNEE_OTEL_INCLUDE_PII=1 → kept
 *   - Unknown field → allowlist drops + debug log on stderr
 *   - OPERATIONAL + SYSTEM fields always pass through
 *   - ALLOWED_FIELD_NAMES / FIELD_PRIVACY_MAP sanity invariants
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  filterAllowlistedFields,
  isPiiIncluded,
  OTEL_FIELD_ALLOWLIST,
  ALLOWED_FIELD_NAMES,
  FIELD_PRIVACY_MAP,
} from "./otel-allowlist.js";
import { EnvVar } from "../constants/env-vars.js";

// ── Env restoration ───────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env[EnvVar.ASSIGNEE_OTEL_INCLUDE_PII];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

// ── isPiiIncluded ─────────────────────────────────────────────────────

describe("isPiiIncluded", () => {
  it("returns false when ASSIGNEE_OTEL_INCLUDE_PII is unset", () => {
    expect(isPiiIncluded()).toBe(false);
  });

  it("returns false when ASSIGNEE_OTEL_INCLUDE_PII is 0", () => {
    process.env[EnvVar.ASSIGNEE_OTEL_INCLUDE_PII] = "0";
    expect(isPiiIncluded()).toBe(false);
  });

  it("returns false when ASSIGNEE_OTEL_INCLUDE_PII is empty string", () => {
    process.env[EnvVar.ASSIGNEE_OTEL_INCLUDE_PII] = "";
    expect(isPiiIncluded()).toBe(false);
  });

  it("returns true when ASSIGNEE_OTEL_INCLUDE_PII is '1'", () => {
    process.env[EnvVar.ASSIGNEE_OTEL_INCLUDE_PII] = "1";
    expect(isPiiIncluded()).toBe(true);
  });
});

// ── filterAllowlistedFields — PII stripping ───────────────────────────

describe("filterAllowlistedFields — PII stripped by default", () => {
  it("drops PII field when includePii=false (default)", () => {
    const result = filterAllowlistedFields(
      {
        rawIntent: "Create an S3 bucket called my-private-bucket",
        action: "plan_complete",
      },
      false,
    );
    expect(result).not.toHaveProperty("rawIntent");
    expect(result).toHaveProperty("action", "plan_complete");
  });

  it("drops resourceArn PII field by default", () => {
    const result = filterAllowlistedFields(
      { resourceArn: "arn:aws:s3:::my-private-bucket", durationMs: 123 },
      false,
    );
    expect(result).not.toHaveProperty("resourceArn");
    expect(result).toHaveProperty("durationMs", 123);
  });

  it("drops accountId PII field by default", () => {
    const result = filterAllowlistedFields(
      { accountId: "210987654321", node: "intent_parser" },
      false,
    );
    expect(result).not.toHaveProperty("accountId");
    expect(result).toHaveProperty("node");
  });
});

describe("filterAllowlistedFields — PII included when opted in", () => {
  it("keeps PII field when includePii=true", () => {
    const result = filterAllowlistedFields(
      { rawIntent: "Create an S3 bucket", action: "plan_complete" },
      true,
    );
    expect(result).toHaveProperty("rawIntent", "Create an S3 bucket");
    expect(result).toHaveProperty("action", "plan_complete");
  });

  it("keeps resourceArn when opted in", () => {
    const result = filterAllowlistedFields(
      { resourceArn: "arn:aws:s3:::my-bucket", node: "resource_provisioner" },
      true,
    );
    expect(result).toHaveProperty("resourceArn");
    expect(result).toHaveProperty("node");
  });
});

// ── filterAllowlistedFields — unknown field dropped ───────────────────

describe("filterAllowlistedFields — unknown fields dropped + debug log", () => {
  it("drops unknown field and emits debug record to stderr", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(
        true as unknown as ReturnType<typeof process.stderr.write>,
      );

    const result = filterAllowlistedFields(
      { unknownNewField: "should-be-dropped", action: "plan_complete" },
      false,
    );

    expect(result).not.toHaveProperty("unknownNewField");
    expect(result).toHaveProperty("action", "plan_complete");
    // stderr should have been written with debug record containing "dropped"
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.action).toBe("fields_dropped");
    expect(parsed.extras.dropped).toContain("unknownNewField (unknown)");
  });

  it("drops multiple unknown fields and lists all in the debug record", () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(
        true as unknown as ReturnType<typeof process.stderr.write>,
      );

    filterAllowlistedFields({ foo: 1, bar: 2, action: "test" }, false);

    const written = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.extras.count).toBe(2);
    expect(parsed.extras.dropped).toContain("foo (unknown)");
    expect(parsed.extras.dropped).toContain("bar (unknown)");
  });
});

// ── filterAllowlistedFields — OPERATIONAL/SYSTEM fields pass through ──

describe("filterAllowlistedFields — OPERATIONAL and SYSTEM fields pass", () => {
  it("passes all OPERATIONAL fields through by default", () => {
    const operationalFields = {
      action: "plan_complete",
      durationMs: 1234,
      result: "success",
      resourceType: "AWS::S3::Bucket",
      mode: "apply",
      node: "plan_generator",
    };
    const result = filterAllowlistedFields(operationalFields, false);
    expect(result).toEqual(operationalFields);
  });

  it("passes SYSTEM fields (runId, spanId, traceId) through by default", () => {
    const systemFields = {
      runId: "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh",
      spanId: "abcd1234efgh5678",
      traceId: "aaaabbbb-cccc-dddd-eeee-ffffgggghhhh",
      schemaVersion: "1",
    };
    const result = filterAllowlistedFields(systemFields, false);
    expect(result).toEqual(systemFields);
  });
});

// ── Empty inputs ──────────────────────────────────────────────────────

describe("filterAllowlistedFields — edge cases", () => {
  it("returns empty object for empty input", () => {
    expect(filterAllowlistedFields({}, false)).toEqual({});
  });

  it("handles object with only PII fields (all stripped) without error", () => {
    const result = filterAllowlistedFields(
      { rawIntent: "intent", resourceArn: "arn:...", accountId: "123" },
      false,
    );
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ── Allowlist metadata invariants ─────────────────────────────────────

describe("OTEL_FIELD_ALLOWLIST — metadata invariants", () => {
  it("has no duplicate field names", () => {
    const names = OTEL_FIELD_ALLOWLIST.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has a non-empty description", () => {
    for (const entry of OTEL_FIELD_ALLOWLIST) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a valid privacy classification", () => {
    const validClasses = new Set(["PII", "SYSTEM", "OPERATIONAL"]);
    for (const entry of OTEL_FIELD_ALLOWLIST) {
      expect(validClasses.has(entry.privacy)).toBe(true);
    }
  });

  it("ALLOWED_FIELD_NAMES set matches OTEL_FIELD_ALLOWLIST", () => {
    for (const entry of OTEL_FIELD_ALLOWLIST) {
      expect(ALLOWED_FIELD_NAMES.has(entry.name)).toBe(true);
    }
    expect(ALLOWED_FIELD_NAMES.size).toBe(OTEL_FIELD_ALLOWLIST.length);
  });

  it("FIELD_PRIVACY_MAP has correct classifications for known fields", () => {
    expect(FIELD_PRIVACY_MAP.get("rawIntent")).toBe("PII");
    expect(FIELD_PRIVACY_MAP.get("resourceArn")).toBe("PII");
    expect(FIELD_PRIVACY_MAP.get("accountId")).toBe("PII");
    expect(FIELD_PRIVACY_MAP.get("action")).toBe("OPERATIONAL");
    expect(FIELD_PRIVACY_MAP.get("runId")).toBe("SYSTEM");
    expect(FIELD_PRIVACY_MAP.get("spanId")).toBe("SYSTEM");
  });
});
