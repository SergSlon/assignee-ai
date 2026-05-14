/**
 * Tests for extractVpcDefaultHint (CP-3, PH1-G-2 Solution B).
 *
 * Probe variations:
 *   A — "vpc-default" hyphenated → "default-vpc"
 *   B — "default VPC" two words → "default-vpc"
 *   C — "existing VPC vpc-12345" → "existing-vpc-id:vpc-12345"
 *   D — bare "EFS file system" (no VPC phrasing) → null (existing behaviour)
 *   E — "in the default VPC" phrase → "default-vpc"
 *   F — "vpcdefault" fused (no hyphen/space) → null (word boundary required)
 */

import { describe, it, expect } from "vitest";
import { extractVpcDefaultHint } from "./vpc-default-hint-extractor.js";

describe("extractVpcDefaultHint", () => {
  // ── Variation A: "vpc-default" hyphenated ──────────────────────────────────
  it("Variation A — 'vpc-default' returns 'default-vpc'", () => {
    expect(
      extractVpcDefaultHint("Create an EFS file system mounted in vpc-default"),
    ).toBe("default-vpc");
  });

  it("Variation A — 'vpc-default' is case-insensitive", () => {
    expect(extractVpcDefaultHint("mount efs in VPC-Default")).toBe(
      "default-vpc",
    );
  });

  // ── Variation B: "default VPC" two words ───────────────────────────────────
  it("Variation B — 'default VPC' returns 'default-vpc'", () => {
    expect(
      extractVpcDefaultHint("Create an EFS file system in the default VPC"),
    ).toBe("default-vpc");
  });

  it("Variation B — lowercase 'default vpc' also matches", () => {
    expect(extractVpcDefaultHint("create efs in default vpc")).toBe(
      "default-vpc",
    );
  });

  // ── Variation C: "existing VPC vpc-XXXXX" ─────────────────────────────────
  it("Variation C — 'existing VPC vpc-12345' captures the vpc-id", () => {
    expect(
      extractVpcDefaultHint(
        "Create an EFS file system in existing VPC vpc-12345",
      ),
    ).toBe("existing-vpc-id:vpc-12345");
  });

  it("Variation C — existing VPC with longer hex id", () => {
    expect(
      extractVpcDefaultHint("Create EFS in existing VPC vpc-0abc1234def56789a"),
    ).toBe("existing-vpc-id:vpc-0abc1234def56789a");
  });

  it("Variation C — existing VPC match takes priority over default VPC", () => {
    const result = extractVpcDefaultHint(
      "Create EFS in existing VPC vpc-12345 in the default VPC",
    );
    expect(result).toMatch(/^existing-vpc-id:/);
  });

  // ── Variation D: no VPC phrasing → null ───────────────────────────────────
  it("Variation D — bare 'Create an EFS file system' returns null", () => {
    expect(extractVpcDefaultHint("Create an EFS file system")).toBeNull();
  });

  it("Variation D — unrelated intent returns null", () => {
    expect(
      extractVpcDefaultHint("Create an S3 bucket with versioning"),
    ).toBeNull();
  });

  // ── Variation E: "in the default VPC" ─────────────────────────────────────
  it("Variation E — 'in the default VPC' phrase returns 'default-vpc'", () => {
    expect(extractVpcDefaultHint("Create EFS mounted in the default VPC")).toBe(
      "default-vpc",
    );
  });

  // ── Variation F: "vpcdefault" fused → null (word boundary required) ────────
  it("Variation F — 'vpcdefault' fused without separator returns null", () => {
    expect(extractVpcDefaultHint("Create EFS in vpcdefault")).toBeNull();
  });

  it("Variation F — 'defaultvpc' fused without separator returns null", () => {
    expect(extractVpcDefaultHint("Create EFS in defaultvpc")).toBeNull();
  });
});
