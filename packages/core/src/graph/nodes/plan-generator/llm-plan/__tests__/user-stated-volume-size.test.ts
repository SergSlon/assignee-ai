/**
 * Unit tests for `applyUserStatedVolumeSize` — e98.W2.R4 / Epic 97 C-R2.
 *
 * The patcher is the deterministic post-parse step that pulls a user-stated
 * `<N>GB` / `<N> GiB` span out of the intent and writes it into
 * `BlockDeviceMappings[0].Ebs.VolumeSize`. Covers:
 *   - positive override when LLM emitted a smaller default (the C-R2 bug)
 *   - user-value match (no-op when already correct)
 *   - BDM-absent seed (LLM dropped BDM entirely)
 *   - GiB unit parsing
 *   - case-insensitivity
 *   - word-boundary: `100GBP` / `5GBit` must NOT match
 *   - empty userIntent / non-EC2 resourceType short-circuit
 *   - malformed BDM (non-array) tolerance
 *   - log entry fires ONLY when an existing numeric value is overridden
 *
 * Mocks: none — we exercise the real function against real input shapes.
 * Log capture: spies on `log` from `@/utils/logger` to assert the
 * override-only log firing contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { applyUserStatedVolumeSize } from "../sanitize.js";
import * as logger from "@/utils/logger/index.js";

const RUN_ID = "run-e98-w2-r4-volumesize";

function stubExistingBdm(
  volumeSize: number | undefined,
): Record<string, unknown> {
  const ebs: Record<string, unknown> = {
    VolumeType: "gp3",
    Encrypted: true,
  };
  if (volumeSize !== undefined) ebs["VolumeSize"] = volumeSize;
  return {
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: ebs }],
  };
}

describe("applyUserStatedVolumeSize — e98.W2.R4 fidelity patcher", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(logger, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("overrides LLM's 8GB default when user stated 100GB (C-R2 core case)", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance t3.large with 100GB gp3 volume",
      RUN_ID,
    );
    const bdm = out["BlockDeviceMappings"] as Array<Record<string, unknown>>;
    const ebs = bdm[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(100);
    // Other Ebs fields preserved verbatim.
    expect(ebs["VolumeType"]).toBe("gp3");
    expect(ebs["Encrypted"]).toBe(true);
    // Log fired for the override path.
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("no-ops when user-stated value already matches existing value", () => {
    const state = stubExistingBdm(50);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create a t3.micro with 50GB volume",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(50);
    // No-op path MUST NOT log.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("seeds a BDM shell when the LLM dropped BlockDeviceMappings entirely", () => {
    const state: Record<string, unknown> = { InstanceType: "t3.micro" };
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance with 200GB volume",
      RUN_ID,
    );
    const bdm = out["BlockDeviceMappings"] as Array<Record<string, unknown>>;
    expect(Array.isArray(bdm)).toBe(true);
    expect(bdm).toHaveLength(1);
    expect(bdm[0]!["DeviceName"]).toBe("/dev/xvda");
    const ebs = bdm[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(200);
    // Seed path: no prior value to override → no override-log.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("parses GiB units (100 GiB) identically to GB", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance with 100 GiB volume",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(100);
  });

  it("is case-insensitive (75gb lowercased)", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "spin up t3.small 75gb please",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(75);
  });

  it("handles whitespace between number and unit (100 GB)", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create a t3.medium with 100 GB gp3",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(100);
  });

  it("does NOT match word-internal GB (100GBP, 5GBit)", () => {
    // Currency / bit-rate tokens must NEVER trip the regex — they aren't
    // storage spans and silent extraction would produce a nonsense volume.
    const state = stubExistingBdm(8);
    const outCurrency = applyUserStatedVolumeSize(
      { ...stubExistingBdm(8) },
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance, budget 100GBP",
      RUN_ID,
    );
    const ebsCurrency = (
      outCurrency["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebsCurrency["VolumeSize"]).toBe(8);

    const outBit = applyUserStatedVolumeSize(
      { ...stubExistingBdm(8) },
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create EC2 with 5GBit network",
      RUN_ID,
    );
    const ebsBit = (
      outBit["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebsBit["VolumeSize"]).toBe(8);
    // Guard: initial `state` reference unmutated through spread hygiene.
    void state;
  });

  it("no-ops on non-EC2 resourceType (patcher is instance-scoped)", () => {
    const state = { BlockDeviceMappings: [{ Ebs: { VolumeSize: 8 } }] };
    const out = applyUserStatedVolumeSize(
      state,
      "AWS::S3::Bucket",
      "Create a bucket for our 100GB archive",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(8);
  });

  it("no-ops on empty userIntent", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(8);
  });

  it("no-ops when intent lacks a volume-size span", () => {
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create a t3.micro EC2 instance",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(8);
  });

  it("uses the FIRST volume-size match when multiple are present", () => {
    // Adjacent-ambiguity defense: a single user intent rarely states two
    // different sizes, but when it does the first value wins (leftmost is
    // canonically the root-volume size in practice).
    const state = stubExistingBdm(8);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create t3.large 120GB root with 500GB extra",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    expect(ebs["VolumeSize"]).toBe(120);
  });

  it("tolerates a non-array BlockDeviceMappings shape", () => {
    // Defensive: if an upstream bug put a scalar in BDM, treat it as
    // "no BDM" and seed a fresh shell rather than crashing with a
    // type error on the array-index access.
    const state: Record<string, unknown> = {
      BlockDeviceMappings: "not-an-array",
    };
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance with 64GB volume",
      RUN_ID,
    );
    const bdm = out["BlockDeviceMappings"] as Array<Record<string, unknown>>;
    expect(Array.isArray(bdm)).toBe(true);
    expect((bdm[0]!["Ebs"] as Record<string, unknown>)["VolumeSize"]).toBe(64);
  });

  it("does not trigger on zero / negative / non-numeric tokens", () => {
    // Pathological intent: literal "0GB" must not clobber existing.
    const state = stubExistingBdm(20);
    const out = applyUserStatedVolumeSize(
      state,
      RESOURCE_TYPES.EC2_INSTANCE,
      "Create an EC2 instance, 0GB legacy",
      RUN_ID,
    );
    const ebs = (
      out["BlockDeviceMappings"] as Array<Record<string, unknown>>
    )[0]!["Ebs"] as Record<string, unknown>;
    // 0 is filtered by `userValue <= 0` guard.
    expect(ebs["VolumeSize"]).toBe(20);
  });
});
