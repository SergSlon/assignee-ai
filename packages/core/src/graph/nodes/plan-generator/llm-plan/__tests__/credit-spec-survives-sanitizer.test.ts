/**
 * e96.W2.R5 + e98.W2.R2 — CreditSpecification.CPUCredits must survive
 * the sanitize phase when injected by plugin defaults.
 *
 * Root cause: `mergePluginDefaults` previously ran BEFORE
 * `sanitizeAgainstSchema`. When the EC2 schema snapshot did not include
 * `CreditSpecification` at the top level (trimmed or older snapshot),
 * the sanitizer would strip the key that the merge had just injected.
 *
 * Fix: move `mergePluginDefaults` to AFTER `sanitizeAgainstSchema`
 * (Phase 3a.1 in llm-plan.ts). These tests lock that invariant by
 * running both phases in sequence with a schema that intentionally
 * omits `CreditSpecification` — simulating the probe failure condition.
 *
 * Two probe scenarios covered:
 *
 *   R5 (e96.W2.R5): LLM emits no CreditSpecification at all (bare
 *   t3.micro intent). Plugin default must inject
 *   `{CPUCredits: "standard"}` AFTER sanitize.
 *
 *   R2 (e98.W2.R2): LLM emits `CreditSpecification: {}` (larger
 *   intent, C-R1 regression). Plugin default must backfill `CPUCredits`
 *   via `isEmptyLeaf` guard AFTER sanitize.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { sanitizeAgainstSchema } from "../sanitize.js";
import { mergePluginDefaults } from "../merge.js";

/**
 * A minimal EC2 schema that intentionally OMITS `CreditSpecification`.
 * This mirrors the trimmed test-fixture schema in
 * `test-fixtures/mcp-mock-responses/schema-ec2-instance.ts` and also
 * simulates an older cached schema snapshot that lacked the key.
 *
 * With the OLD phase order (merge BEFORE sanitize), the sanitizer
 * would strip `CreditSpecification` because it is not in these
 * schemaKeys — exactly the probe failure condition.
 *
 * With the NEW phase order (sanitize BEFORE merge), the sanitizer
 * runs on the raw LLM output (which has no CreditSpecification), and
 * the merge step injections are never subject to schema stripping.
 */
const EC2_SCHEMA_WITHOUT_CREDIT_SPEC = {
  properties: {
    InstanceType: { type: "string" },
    ImageId: { type: "string" },
    KeyName: { type: "string" },
    MetadataOptions: {
      type: "object",
      properties: {
        HttpTokens: { type: "string" },
        HttpPutResponseHopLimit: { type: "integer" },
      },
    },
    BlockDeviceMappings: { type: "array" },
    DisableApiTermination: { type: "boolean" },
    EbsOptimized: { type: "boolean" },
    // CreditSpecification intentionally absent — probe failure condition.
  },
};

const schemaKeys = Object.keys(EC2_SCHEMA_WITHOUT_CREDIT_SPEC.properties);

/**
 * Runs both phases in the post-fix order: sanitize first, then merge.
 * Returns the resulting desiredState.
 */
function runPipeline(
  llmOutput: Record<string, unknown>,
): Record<string, unknown> {
  // Phase 3a: sanitize (old code had mergePluginDefaults BEFORE this)
  const sanitized = sanitizeAgainstSchema(
    llmOutput,
    EC2_SCHEMA_WITHOUT_CREDIT_SPEC,
    schemaKeys,
    "test-run-id",
    RESOURCE_TYPES.EC2_INSTANCE,
  );
  // Phase 3a.1: merge plugin defaults AFTER sanitize (the fix)
  return mergePluginDefaults(sanitized, RESOURCE_TYPES.EC2_INSTANCE);
}

/**
 * Runs both phases in the OLD (broken) order: merge first, then sanitize.
 * Used to confirm the fix actually changed behaviour (not a vacuous test).
 */
function runBrokenPipeline(
  llmOutput: Record<string, unknown>,
): Record<string, unknown> {
  // OLD order: merge plugin defaults BEFORE sanitize
  const withDefaults = mergePluginDefaults(
    llmOutput,
    RESOURCE_TYPES.EC2_INSTANCE,
  );
  // Sanitizer then strips CreditSpecification because it's not in schemaKeys
  return sanitizeAgainstSchema(
    withDefaults,
    EC2_SCHEMA_WITHOUT_CREDIT_SPEC,
    schemaKeys,
    "test-run-id",
    RESOURCE_TYPES.EC2_INSTANCE,
  );
}

describe("e96.W2.R5 — CreditSpecification survives sanitizer (t3.micro, plugin default path)", () => {
  const t3MicroLlmOutput: Record<string, unknown> = {
    InstanceType: "t3.micro",
    ImageId: "ami-0abcdef1234567890",
    // LLM did NOT emit CreditSpecification — plugin default path
  };

  it("NEW order (fix): sanitize then merge — CreditSpecification.CPUCredits present", () => {
    const result = runPipeline(t3MicroLlmOutput);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    expect(
      credit,
      "CreditSpecification must be injected post-sanitize",
    ).toBeDefined();
    expect(credit?.["CPUCredits"]).toBe("standard");
  });

  it("OLD order (broken): merge then sanitize — CreditSpecification stripped (regression lock)", () => {
    // This confirms the fix is not vacuous: the old order DID fail.
    const result = runBrokenPipeline(t3MicroLlmOutput);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    // Old order: sanitizer strips CreditSpecification because it's not in schema
    expect(credit).toBeUndefined();
  });
});

describe("e98.W2.R2 — CreditSpecification survives sanitizer (t3.large + gp3, empty-leaf C-R1 path)", () => {
  const t3LargeGp3LlmOutput: Record<string, unknown> = {
    InstanceType: "t3.large",
    ImageId: "ami-0abcdef1234567890",
    // LLM emitted an empty-leaf CreditSpecification — the C-R1 bug shape
    CreditSpecification: {},
  };

  it("NEW order (fix): sanitize then merge — CPUCredits backfilled post-sanitize", () => {
    const result = runPipeline(t3LargeGp3LlmOutput);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    expect(
      credit,
      "CreditSpecification must be backfilled post-sanitize",
    ).toBeDefined();
    expect(credit?.["CPUCredits"]).toBe("standard");
  });

  it("OLD order (broken): merge then sanitize — CreditSpecification stripped (regression lock)", () => {
    // Old order: merge backfills CPUCredits on the empty leaf, then
    // sanitizer strips the entire CreditSpecification key.
    const result = runBrokenPipeline(t3LargeGp3LlmOutput);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    expect(credit).toBeUndefined();
  });

  it("schema-stripped path: sanitizer removes CreditSpec (absent from schema), merge fills default", () => {
    // When the schema snapshot LACKS CreditSpecification (this test's
    // EC2_SCHEMA_WITHOUT_CREDIT_SPEC), both old and new pipeline orders
    // end up with the plugin default:
    //   - OLD: merge injects {CPUCredits:"unlimited"}, sanitizer strips the key entirely
    //   - NEW: sanitizer strips the key (nothing to strip for absent key),
    //          merge injects plugin default {CPUCredits:"standard"}
    //
    // In production, the live EC2 schema DOES include CreditSpecification,
    // so LLM-emitted {CPUCredits:"unlimited"} passes through sanitize
    // and deepMergeDefault preserves it (non-empty leaf). This test only
    // documents the trimmed-schema edge case.
    const llmOutputWithUnlimited: Record<string, unknown> = {
      InstanceType: "t3.small",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: { CPUCredits: "unlimited" },
    };
    const result = runPipeline(llmOutputWithUnlimited);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    // Sanitizer strips CreditSpecification (not in trimmed schema),
    // then merge injects the plugin default.
    expect(credit?.["CPUCredits"]).toBe("standard");
  });
});

describe("e96.W2.R5 / e98.W2.R2 — schema WITH CreditSpecification (control: no change needed)", () => {
  // When the live schema DOES include CreditSpecification, both old and new
  // phase orders should produce the same result. This is the common case
  // with the full AWS CFN schema.
  const schemaWithCreditSpec = {
    properties: {
      ...EC2_SCHEMA_WITHOUT_CREDIT_SPEC.properties,
      CreditSpecification: {
        type: "object",
        properties: {
          CPUCredits: { type: "string" },
        },
      },
    },
  };
  const schemaKeysWithCredit = Object.keys(schemaWithCreditSpec.properties);

  it("when schema includes CreditSpecification, new order still produces CPUCredits=standard", () => {
    const llmOutput: Record<string, unknown> = {
      InstanceType: "t3.micro",
      ImageId: "ami-0abcdef1234567890",
    };
    const sanitized = sanitizeAgainstSchema(
      llmOutput,
      schemaWithCreditSpec,
      schemaKeysWithCredit,
      "test-run-id-full-schema",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const result = mergePluginDefaults(sanitized, RESOURCE_TYPES.EC2_INSTANCE);
    const credit = result["CreditSpecification"] as
      | Record<string, unknown>
      | undefined;
    expect(credit?.["CPUCredits"]).toBe("standard");
  });
});
