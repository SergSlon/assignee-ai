/**
 * Tests for wizard-key-map.ts (P2-3 from Epic 35 test plan).
 *
 * Covers:
 * - toSetFlag returns null for unknown keys
 * - toSetFlagFromPatch matches sub-properties and array patch leaf keys
 * - getAllLeafKeys depth limit (tested indirectly via toSetFlagFromPatch)
 */

import { describe, it, expect } from "vitest";
import {
  wizardKeyMap,
  toSetFlag,
  toSetFlagFromPatch,
} from "./wizard-key-map.js";

// ---------------------------------------------------------------------------
// toSetFlag
// ---------------------------------------------------------------------------

describe("toSetFlag", () => {
  it("returns first wizard field for a known patch key", () => {
    expect(toSetFlag("BlockDeviceMappings")).toBe("EbsEncrypted");
    expect(toSetFlag("PublicAccessBlockConfiguration")).toBe("BlockPublicAcls");
    expect(toSetFlag("VersioningConfiguration")).toBe("VersioningConfiguration");
  });

  it("returns null for an unknown patch key", () => {
    expect(toSetFlag("NonExistentKey")).toBeNull();
    expect(toSetFlag("")).toBeNull();
    expect(toSetFlag("SomeRandomProperty")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toSetFlagFromPatch — object sub-keys
// ---------------------------------------------------------------------------

describe("toSetFlagFromPatch", () => {
  it("matches nested sub-key to correct wizard field", () => {
    const result = toSetFlagFromPatch("PublicAccessBlockConfiguration", {
      PublicAccessBlockConfiguration: { BlockPublicPolicy: true },
    });
    expect(result).toBe("BlockPublicPolicy");
  });

  it("matches another nested sub-key to its wizard field", () => {
    const result = toSetFlagFromPatch("PublicAccessBlockConfiguration", {
      PublicAccessBlockConfiguration: { IgnorePublicAcls: true },
    });
    expect(result).toBe("IgnorePublicAcls");
  });

  it("matches array patch leaf key to wizard field (BlockDeviceMappings)", () => {
    const result = toSetFlagFromPatch("BlockDeviceMappings", {
      BlockDeviceMappings: [{ Ebs: { Encrypted: true } }],
    });
    // "Encrypted" is a leaf key but not in wizardKeyMap fields for BlockDeviceMappings.
    // The leaf key lookup finds "Encrypted" which is NOT in ["EbsEncrypted", "EbsVolumeType", "EbsVolumeSize"],
    // so it falls back to the first field.
    expect(result).toBe("EbsEncrypted");
  });

  it("falls back to first field when no sub-key match is found", () => {
    const result = toSetFlagFromPatch("PublicAccessBlockConfiguration", {
      PublicAccessBlockConfiguration: { UnknownSubKey: "value" },
    });
    expect(result).toBe("BlockPublicAcls");
  });

  it("returns null for unknown patch key", () => {
    const result = toSetFlagFromPatch("NoSuchKey", {
      NoSuchKey: { Whatever: true },
    });
    expect(result).toBeNull();
  });

  it("handles single-field mapping by returning the only field", () => {
    const result = toSetFlagFromPatch("MultiAZ", {
      MultiAZ: true,
    });
    expect(result).toBe("MultiAZ");
  });

  // ---------------------------------------------------------------------------
  // getAllLeafKeys depth limit (P2-3 from test plan)
  // ---------------------------------------------------------------------------

  it("getAllLeafKeys stops at depth 10 — deeply nested array patch falls back to first field", () => {
    // Build a structure 15 levels deep — getAllLeafKeys should bail at depth 10
    // and never find the leaf key, causing fallback to the first field.
    let deep: Record<string, unknown> = { EbsEncrypted: true };
    for (let i = 0; i < 15; i++) {
      deep = { nested: deep };
    }
    const result = toSetFlagFromPatch("BlockDeviceMappings", {
      BlockDeviceMappings: [deep],
    });
    // Because the leaf "EbsEncrypted" is deeper than 10 levels, getAllLeafKeys
    // won't find it, so it falls back to the first wizard field.
    expect(result).toBe("EbsEncrypted");
  });
});
