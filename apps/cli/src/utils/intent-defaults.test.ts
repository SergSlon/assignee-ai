import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import type { ResourceField } from "@assignee/core";
import { getIntentDefaults, applyIntentOverrides } from "./intent-defaults.js";

// ── getIntentDefaults unit tests ──────────────────────────────────────────────

describe("getIntentDefaults", () => {
  // Task 3.2: EC2 "web server" → InstanceType = t3.small
  it('EC2 + "web server" → InstanceType = t3.small with correct reason', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for a web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toEqual({
      fieldName: "InstanceType",
      value: "t3.small",
      reason: "Selected for web serving — burstable with 2 GiB RAM",
    });
  });

  it('EC2 + "web app" → InstanceType = t3.small', () => {
    const overrides = getIntentDefaults(
      "Launch EC2 for web app",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("t3.small");
  });

  it('EC2 + "api server" → InstanceType = t3.small', () => {
    const overrides = getIntentDefaults(
      "Create an api server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("t3.small");
  });

  // Task 3.3: EC2 "machine learning" → InstanceType = c5.xlarge
  it('EC2 + "machine learning" → InstanceType = c5.xlarge with correct reason', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for machine learning",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toEqual({
      fieldName: "InstanceType",
      value: "c5.xlarge",
      reason: "Selected for ML/compute — 4 vCPU, 8 GiB, compute-optimized",
    });
  });

  it('EC2 + "ml training" → InstanceType = c5.xlarge', () => {
    const overrides = getIntentDefaults(
      "Spin up EC2 for ml training workload",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("c5.xlarge");
  });

  it('EC2 + "deep learning" → InstanceType = c5.xlarge', () => {
    const overrides = getIntentDefaults(
      "EC2 for deep learning experiments",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("c5.xlarge");
  });

  // Task 3.4: EC2 "database" → InstanceType = r5.large
  it('EC2 + "database" → InstanceType = r5.large with correct reason', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for database",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toEqual({
      fieldName: "InstanceType",
      value: "r5.large",
      reason: "Selected for data workloads — 16 GiB memory-optimized",
    });
  });

  it('EC2 + "cache" → InstanceType = r5.large', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for cache",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("r5.large");
  });

  it('EC2 + "redis" → InstanceType = r5.large', () => {
    const overrides = getIntentDefaults(
      "EC2 for redis deployment",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("r5.large");
  });

  // Task 3.5: S3 "logging" → lifecycle fields
  it('S3 + "logging" → EnableLifecycle=true, TransitionDays="90", ExpirationDays="365"', () => {
    const overrides = getIntentDefaults(
      "Create an S3 bucket for logging",
      RESOURCE_TYPES.S3_BUCKET,
    );

    expect(overrides).toHaveLength(3);

    const lifecycle = overrides.find((o) => o.fieldName === "EnableLifecycle");
    expect(lifecycle?.value).toBe(true);
    expect(lifecycle?.reason).toContain("90-day IA transition");

    const transition = overrides.find(
      (o) => o.fieldName === "LifecycleTransitionDays",
    );
    expect(transition?.value).toBe("90");

    const expiration = overrides.find(
      (o) => o.fieldName === "LifecycleExpirationDays",
    );
    expect(expiration?.value).toBe("365");
  });

  it('S3 + "audit trail" → lifecycle fields', () => {
    const overrides = getIntentDefaults(
      "S3 bucket for audit trail",
      RESOURCE_TYPES.S3_BUCKET,
    );

    expect(overrides).toHaveLength(3);
    expect(
      overrides.find((o) => o.fieldName === "EnableLifecycle")?.value,
    ).toBe(true);
  });

  // Task 3.6: S3 "static website" → CORS + public access
  it('S3 + "static website" → EnableCors=true, PublicAccessBlockConfiguration=false', () => {
    const overrides = getIntentDefaults(
      "Create S3 for static website hosting",
      RESOURCE_TYPES.S3_BUCKET,
    );

    expect(overrides).toHaveLength(2);

    const cors = overrides.find((o) => o.fieldName === "EnableCors");
    expect(cors?.value).toBe(true);
    expect(cors?.reason).toContain("CORS enabled");

    const publicAccess = overrides.find(
      (o) => o.fieldName === "PublicAccessBlockConfiguration",
    );
    expect(publicAccess?.value).toBe(false);
    expect(publicAccess?.reason).toContain("public access allowed");
  });

  it('S3 + "frontend hosting" → CORS + public access', () => {
    const overrides = getIntentDefaults(
      "S3 bucket for frontend hosting",
      RESOURCE_TYPES.S3_BUCKET,
    );

    expect(overrides).toHaveLength(2);
    expect(overrides.find((o) => o.fieldName === "EnableCors")?.value).toBe(
      true,
    );
  });

  // Task 3.7: EC2 no keywords → empty array
  it("EC2 intent with no keywords → empty array", () => {
    const overrides = getIntentDefaults(
      "Create an EC2 instance",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toEqual([]);
  });

  // Task 3.8: S3 no keywords → empty array
  it("S3 intent with no keywords → empty array", () => {
    const overrides = getIntentDefaults(
      "Create an S3 bucket",
      RESOURCE_TYPES.S3_BUCKET,
    );

    expect(overrides).toEqual([]);
  });

  // Task 3.9: case-insensitive matching
  it('case-insensitive: "Web Server" matches', () => {
    const overrides = getIntentDefaults(
      "Create EC2 for Web Server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("t3.small");
  });

  it('case-insensitive: "WEB SERVER" matches', () => {
    const overrides = getIntentDefaults(
      "Create EC2 for WEB SERVER",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("t3.small");
  });

  it('case-insensitive: "Machine Learning" matches', () => {
    const overrides = getIntentDefaults(
      "EC2 for Machine Learning",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("c5.xlarge");
  });

  // Edge cases
  it("empty intent → empty array", () => {
    expect(getIntentDefaults("", RESOURCE_TYPES.EC2_INSTANCE)).toEqual([]);
  });

  it("empty resourceType → empty array", () => {
    expect(getIntentDefaults("web server", "")).toEqual([]);
  });

  it("unknown resource type → empty array", () => {
    expect(getIntentDefaults("web server", "AWS::Unknown::Type")).toEqual([]);
  });

  it("first matching rule per field wins (no duplicate InstanceType)", () => {
    // "web server cache" matches both web server (t3.small) and cache (r5.large)
    // First rule wins for InstanceType
    const overrides = getIntentDefaults(
      "Create EC2 for web server cache",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.value).toBe("t3.small");
  });
});

// ── applyIntentOverrides unit tests ───────────────────────────────────────────

describe("applyIntentOverrides", () => {
  const makeField = (
    name: string,
    initialValue?: unknown,
    hint?: string,
  ): ResourceField => ({
    name,
    question: {
      type: "string",
      label: name,
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(hint ? { hint } : {}),
    },
  });

  it("returns fields unchanged when overrides is empty", () => {
    const fields = [makeField("InstanceType", "t3.micro")];
    const result = applyIntentOverrides(fields, []);
    expect(result).toBe(fields); // same reference
  });

  it("overrides initialValue and adds intent hint", () => {
    const fields = [makeField("InstanceType", "t3.micro")];
    const overrides = [
      {
        fieldName: "InstanceType",
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
      },
    ];

    const result = applyIntentOverrides(fields, overrides);

    expect(result[0]!.question.initialValue).toBe("t3.small");
    expect(result[0]!.question.hint).toBe(
      "Pre-selected based on your intent: Selected for web serving — burstable with 2 GiB RAM",
    );
  });

  it("appends intent hint to existing hint", () => {
    const fields = [
      makeField("InstanceType", "t3.micro", "Some existing hint"),
    ];
    const overrides = [
      {
        fieldName: "InstanceType",
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
      },
    ];

    const result = applyIntentOverrides(fields, overrides);

    expect(result[0]!.question.hint).toBe(
      "Some existing hint\nPre-selected based on your intent: Selected for web serving — burstable with 2 GiB RAM",
    );
  });

  it("adds public access warning for PublicAccessBlockConfiguration=false", () => {
    const fields: ResourceField[] = [
      {
        name: "PublicAccessBlockConfiguration",
        question: {
          type: "boolean",
          label: "Block all public access?",
          initialValue: true,
          hint: "Blocks all public ACLs and policies.",
        },
      },
    ];
    const overrides = [
      {
        fieldName: "PublicAccessBlockConfiguration",
        value: false,
        reason: "Pre-configured for static web hosting — public access allowed",
      },
    ];

    const result = applyIntentOverrides(fields, overrides);

    expect(result[0]!.question.initialValue).toBe(false);
    expect(result[0]!.question.hint).toContain(
      "Warning: Public access will be enabled. Ensure this bucket does not contain sensitive data.",
    );
  });

  it("does not modify fields without matching overrides", () => {
    const fields = [
      makeField("InstanceType", "t3.micro"),
      makeField("ImageId"),
    ];
    const overrides = [
      {
        fieldName: "InstanceType",
        value: "t3.small",
        reason: "test reason",
      },
    ];

    const result = applyIntentOverrides(fields, overrides);

    expect(result[0]!.question.initialValue).toBe("t3.small");
    // ImageId should be unchanged
    expect(result[1]!.question.initialValue).toBeUndefined();
    expect(result[1]!.question.hint).toBeUndefined();
  });

  it("is a pure function — does not mutate input fields", () => {
    const fields = [makeField("InstanceType", "t3.micro")];
    const overrides = [
      {
        fieldName: "InstanceType",
        value: "t3.small",
        reason: "test reason",
      },
    ];

    const result = applyIntentOverrides(fields, overrides);

    // Original field should be unchanged
    expect(fields[0]!.question.initialValue).toBe("t3.micro");
    // Result should have the override
    expect(result[0]!.question.initialValue).toBe("t3.small");
  });
});
