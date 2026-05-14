/**
 * Tests for efsDefaultVpcHint helper (CP-3, PH1-G-2 Solution B).
 *
 * Probe variations:
 *   A — EFS + _VpcDefaultHint="default-vpc" → advisory fires (Variation A phrase)
 *   B — EFS + _VpcDefaultHint="default-vpc" from "default VPC" → advisory fires
 *   C — EFS + _VpcDefaultHint="existing-vpc-id:vpc-12345" → advisory fires with vpc-id
 *   D — EFS + no _VpcDefaultHint → no advisory (existing behaviour preserved)
 *   E — advisory text matches exact required substrings from spec line 17
 *   F — non-EFS resource type → no advisory (guard)
 */

import { describe, it, expect } from "vitest";
import { efsDefaultVpcHint } from "./efs-default-vpc-hint.js";
import { RESOURCE_TYPES } from "@/index.js";

const EFS = RESOURCE_TYPES.EFS_FILE_SYSTEM;

describe("efsDefaultVpcHint", () => {
  // ── Variation A: "vpc-default" → advisory fires ────────────────────────────
  it("Variation A — fires advisory for EFS with _VpcDefaultHint='default-vpc'", () => {
    const result = efsDefaultVpcHint(EFS, { _VpcDefaultHint: "default-vpc" });
    expect(result).toHaveLength(1);
  });

  // ── Variation B: "default VPC" phrase → advisory fires ────────────────────
  it("Variation B — fires advisory from 'default VPC' phrasing (same hint value)", () => {
    const result = efsDefaultVpcHint(EFS, { _VpcDefaultHint: "default-vpc" });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("vpc-default");
  });

  // ── Variation C: "existing VPC vpc-12345" → advisory with vpc-id ──────────
  it("Variation C — advisory for existing-vpc-id contains the captured vpc-id", () => {
    const result = efsDefaultVpcHint(EFS, {
      _VpcDefaultHint: "existing-vpc-id:vpc-12345",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("vpc-12345");
    expect(result[0]).toContain("--set VpcId=");
  });

  // ── Variation D: no hint → no advisory ────────────────────────────────────
  it("Variation D — no advisory when _VpcDefaultHint is absent (existing behaviour)", () => {
    const result = efsDefaultVpcHint(EFS, {});
    expect(result).toHaveLength(0);
  });

  it("Variation D — no advisory when _VpcDefaultHint is not a string", () => {
    const result = efsDefaultVpcHint(EFS, { _VpcDefaultHint: null });
    expect(result).toHaveLength(0);
  });

  // ── Variation E: advisory wording per spec line 25 (EPIC-106-4 polish) ──────
  it("Variation E — advisory contains exact required substrings from spec (EPIC-106-4)", () => {
    const result = efsDefaultVpcHint(EFS, { _VpcDefaultHint: "default-vpc" });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("vpc-default");
    expect(result[0]).toContain("EFS currently always creates a private VPC");
    expect(result[0]).toContain(
      "deferred-existing-resource-discovery-extractor",
    );
    expect(result[0]).toContain("--set VpcId=<id>");
  });

  it("Variation E — advisory uses WARNING icon", () => {
    const result = efsDefaultVpcHint(EFS, { _VpcDefaultHint: "default-vpc" });
    expect(result[0]).toContain("⚠️");
  });

  // ── Variation F: non-EFS resource → no advisory ───────────────────────────
  it("Variation F — no advisory for S3 bucket resource type", () => {
    const result = efsDefaultVpcHint(RESOURCE_TYPES.S3_BUCKET, {
      _VpcDefaultHint: "default-vpc",
    });
    expect(result).toHaveLength(0);
  });

  it("Variation F — no advisory for Lambda function resource type", () => {
    const result = efsDefaultVpcHint(RESOURCE_TYPES.LAMBDA_FUNCTION, {
      _VpcDefaultHint: "default-vpc",
    });
    expect(result).toHaveLength(0);
  });

  it("Variation F — no advisory for EC2 VPC resource type", () => {
    const result = efsDefaultVpcHint(RESOURCE_TYPES.EC2_VPC, {
      _VpcDefaultHint: "default-vpc",
    });
    expect(result).toHaveLength(0);
  });
});
