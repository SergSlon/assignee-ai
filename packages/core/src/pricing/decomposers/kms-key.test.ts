/**
 * KMS Key pricing decomposer tests.
 *
 * Epic 92 u.e (D-23): pins the fixed `$1/key/month` catalog entry so a
 * future refactor cannot silently drop the decomposer row that drives
 * the CMK cost line in `list --total-cost`. The actual dollar amount
 * is not hardcoded anywhere — the decomposer declares the line item
 * with `priceUnit: PER_KEY_MONTH` and the pricing layer fetches the
 * rate from the AWS Pricing MCP at runtime.
 *
 * Note: the original D-23 finding reported `list --total-cost` under-
 * counting because the _list-side_ billing probe (not the plan-time
 * decomposer) fails to emit a per-row cost for CMKs. That probe is
 * owned by `apps/cli/src/services/billing/` and is flagged as a
 * residual (`u.e-residual-D-23-mcp-filter`). Here we only pin the
 * decomposer contract so the plan-time breakdown is correct.
 */

import { describe, it, expect } from "vitest";
import { kmsKeyPricingDecomposer } from "./kms-key.js";

describe("kmsKeyPricingDecomposer", () => {
  it("resourceType is AWS::KMS::Key", () => {
    expect(kmsKeyPricingDecomposer.resourceType).toBe("AWS::KMS::Key");
  });

  it("emits a fixed per-key-month line item (D-23: CMK flat $1/month)", () => {
    const items = kmsKeyPricingDecomposer.decompose({});
    const storage = items.find((i) => i.label === "Key storage");
    expect(storage).toBeDefined();
    // Fixed kind so `formatPricingBreakdown` tallies it into the
    // subtotal (usage-based rows are per-unit rates that can't be
    // summed without workload data).
    expect(storage!.kind).toBe("fixed");
    expect(storage!.quantity).toBe(1);
    expect(storage!.unit).toBe("key");
    expect(storage!.priceUnit).toBe("/key-mo");
    // Per feedback_no_hardcoded_prices the decomposer MUST NOT carry
    // a dollar amount — the rate comes from the Pricing MCP via the
    // filter list below.
    const keyStorageJson = JSON.stringify(storage);
    expect(keyStorageJson).not.toMatch(/\$[0-9]/);
    // Filters target the productFamily="Encryption Key" row in the
    // AWS KMS pricing catalog.
    const productFamily = storage!.filters.find(
      (f) => f.Field === "productFamily",
    );
    expect(productFamily?.Value).toBe("Encryption Key");
  });

  it("emits a usage-based API-request line item (symmetric default)", () => {
    const items = kmsKeyPricingDecomposer.decompose({});
    const api = items.find((i) => i.label === "API calls");
    expect(api).toBeDefined();
    expect(api!.kind).toBe("usage_based");
    expect(api!.description).toContain("symmetric");
  });

  it("switches description to asymmetric when KeySpec is ECC/RSA/HMAC", () => {
    const items = kmsKeyPricingDecomposer.decompose({
      KeySpec: "ECC_NIST_P256",
    });
    const api = items.find((i) => i.label === "API calls");
    expect(api!.description).toContain("asymmetric");
  });

  it("all filters use TERM_MATCH", () => {
    const items = kmsKeyPricingDecomposer.decompose({});
    for (const item of items) {
      for (const f of item.filters) {
        expect(f.Type).toBe("TERM_MATCH");
      }
    }
  });
});
