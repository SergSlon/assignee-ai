/**
 * Epic 98 Wave 2 fixer e98.W2.R2 — merge.ts empty-leaf backfill.
 *
 * Closes C-R1 live-FAIL from Epic 97: `CreditSpecification: {}` emitted
 * by the LLM on larger EC2 intents (e.g. `t3.large with 100GB gp3 volume`)
 * defeated the e96.W2.R5 casing-alignment fix. The guard in
 * `mergePluginDefaults` previously skipped any key whose value was not
 * `undefined` — an empty object `{}` passed that check, so the plugin
 * default `{CPUCredits: "standard"}` never landed, and the "CPU Credits"
 * plan row re-blanked.
 *
 * New contract locked by this suite:
 *
 *   1. `isEmptyLeaf(v)` returns true for `undefined`, `null`, `{}`, `[]`,
 *      `""`. Everything else (including `false`, `0`, non-empty objects,
 *      non-empty arrays, non-empty strings) is non-empty.
 *   2. `mergePluginDefaults` replaces empty-leaf values with the plugin
 *      default — the C-R1 root-cause fix.
 *   3. For object-valued plugin defaults, a partial LLM shell is
 *      deep-merge backfilled with missing sub-keys (LLM-emitted sub-keys
 *      win). `CreditSpecification: {Something: "x"}` becomes
 *      `{Something: "x", CPUCredits: "standard"}`.
 *   4. User-stated values (propagated via `mergeElicitedOptions` upstream
 *      and already on `desiredState` by the time `mergePluginDefaults`
 *      runs) are preserved — `CreditSpecification: {CPUCredits: "unlimited"}`
 *      stays `"unlimited"`, not `"standard"`.
 *   5. Resource types NOT on the backfill allowlist are untouched
 *      (guards against accidental BP-suppression on S3/Lambda/etc.).
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { isEmptyLeaf, mergePluginDefaults } from "../merge.js";

describe("isEmptyLeaf — e98.W2.R2 emptiness contract", () => {
  it("treats undefined as empty", () => {
    expect(isEmptyLeaf(undefined)).toBe(true);
  });

  it("treats null as empty", () => {
    expect(isEmptyLeaf(null)).toBe(true);
  });

  it("treats empty string as empty", () => {
    expect(isEmptyLeaf("")).toBe(true);
  });

  it("treats empty object as empty (the C-R1 bug)", () => {
    expect(isEmptyLeaf({})).toBe(true);
  });

  it("treats empty array as empty", () => {
    expect(isEmptyLeaf([])).toBe(true);
  });

  it("does NOT treat non-empty object as empty", () => {
    expect(isEmptyLeaf({ CPUCredits: "standard" })).toBe(false);
  });

  it("does NOT treat non-empty array as empty", () => {
    expect(isEmptyLeaf(["a"])).toBe(false);
  });

  it("does NOT treat false as empty (boolean carries signal)", () => {
    expect(isEmptyLeaf(false)).toBe(false);
  });

  it("does NOT treat 0 as empty (number carries signal)", () => {
    expect(isEmptyLeaf(0)).toBe(false);
  });

  it("does NOT treat non-empty string as empty", () => {
    expect(isEmptyLeaf("standard")).toBe(false);
  });
});

describe("mergePluginDefaults — e98.W2.R2 empty-leaf backfill", () => {
  // Variation 1 — baseline t3.micro (no LLM-emitted CreditSpecification).
  it("injects CreditSpecification when the LLM omitted it entirely", () => {
    const llmOutput: Record<string, unknown> = {
      InstanceType: "t3.micro",
      ImageId: "ami-0abcdef1234567890",
    };
    const merged = mergePluginDefaults(llmOutput, RESOURCE_TYPES.EC2_INSTANCE);
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit).toBeDefined();
    expect(credit["CPUCredits"]).toBe("standard");
  });

  // Variation 2 — C-R1 tripwire. LLM emitted `{}` (empty object) as
  // CreditSpecification on a larger-EC2 intent. Pre-fix: merge skipped
  // the key because `!== undefined` was true, so CPUCredits stayed
  // unset. Post-fix: isEmptyLeaf({}) === true, so plugin default lands.
  it("restores CPUCredits when the LLM emitted an empty `CreditSpecification: {}` shell", () => {
    const llmOutput: Record<string, unknown> = {
      InstanceType: "t3.large",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: {},
    };
    const merged = mergePluginDefaults(llmOutput, RESOURCE_TYPES.EC2_INSTANCE);
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit).toEqual({ CPUCredits: "standard" });
  });

  // Variation 3 — stub-LLM partial shell. LLM emitted SOME sub-keys on
  // CreditSpecification but NOT CPUCredits. Deep-merge backfills the
  // missing sub-key while preserving what the LLM said.
  it("deep-merges missing sub-keys on a partial LLM `CreditSpecification` object", () => {
    const llmOutput: Record<string, unknown> = {
      InstanceType: "t3.medium",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: { SomeOtherKey: "preserved" },
    };
    const merged = mergePluginDefaults(llmOutput, RESOURCE_TYPES.EC2_INSTANCE);
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit["SomeOtherKey"]).toBe("preserved");
    expect(credit["CPUCredits"]).toBe("standard");
  });

  // Variation 4 — user-wins. When the user stated `CPUCredits unlimited`
  // (propagated by intent-parser + mergeElicitedOptions upstream), the
  // plugin default must not clobber the stated value.
  it("preserves user-stated CPUCredits='unlimited' (user wins over plugin default)", () => {
    const llmOutputWithUserOption: Record<string, unknown> = {
      InstanceType: "t3.small",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: { CPUCredits: "unlimited" },
    };
    const merged = mergePluginDefaults(
      llmOutputWithUserOption,
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit["CPUCredits"]).toBe("unlimited");
  });

  // -------------------------------------------------------------------
  // Regression locks
  // -------------------------------------------------------------------

  it("leaves non-allowlisted resource types untouched (S3 safety)", () => {
    // S3 is NOT on the backfill allowlist — BP-enforcement integration
    // tests rely on S3 plans that LACK PublicAccessBlockConfiguration
    // so that BP-S3-001 can fire. Accidental backfill would silently
    // dismantle those tests.
    const s3LlmOutput: Record<string, unknown> = {
      BucketName: "my-bucket",
    };
    const merged = mergePluginDefaults(s3LlmOutput, RESOURCE_TYPES.S3_BUCKET);
    expect(merged).toEqual(s3LlmOutput);
  });

  it("returns input unchanged when resourceType is empty", () => {
    const input: Record<string, unknown> = { InstanceType: "t3.micro" };
    expect(mergePluginDefaults(input, "")).toEqual(input);
  });

  it("does not rebuild the input object when nothing needs merging (pure copy semantics still hold)", () => {
    const input: Record<string, unknown> = {
      InstanceType: "t3.micro",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: { CPUCredits: "standard" },
    };
    const merged = mergePluginDefaults(input, RESOURCE_TYPES.EC2_INSTANCE);
    // The returned object carries the same CreditSpecification contract.
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit["CPUCredits"]).toBe("standard");
  });

  it("restores CPUCredits when the LLM emitted `CreditSpecification: null`", () => {
    // null is an empty leaf — same path as undefined / {}.
    const llmOutput: Record<string, unknown> = {
      InstanceType: "t3.large",
      ImageId: "ami-0abcdef1234567890",
      CreditSpecification: null,
    };
    const merged = mergePluginDefaults(llmOutput, RESOURCE_TYPES.EC2_INSTANCE);
    const credit = merged["CreditSpecification"] as Record<string, unknown>;
    expect(credit).toEqual({ CPUCredits: "standard" });
  });
});
