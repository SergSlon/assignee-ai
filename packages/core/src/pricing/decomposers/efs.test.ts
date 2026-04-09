import { describe, it, expect } from "vitest";
import { efsPricingDecomposer } from "./efs.js";
import {
  PricingServiceCode as SC,
  PricingProductFamily as PF,
  PricingKind as K,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";
import { PricingUnit } from "../units.js";
import { LineItemLabel } from "../line-item-labels.js";

describe("efsPricingDecomposer", () => {
  it("targets AWS::EFS::FileSystem", () => {
    expect(efsPricingDecomposer.resourceType).toBe("AWS::EFS::FileSystem");
  });

  it("returns exactly one line item (Standard storage) for the default file system", () => {
    const items = efsPricingDecomposer.decompose({});
    expect(items).toHaveLength(1);
    expect(items[0]?.description).toBe("Standard storage");
  });

  it("queries the AmazonEFS service code against the Storage product family", () => {
    const [storage] = efsPricingDecomposer.decompose({});
    expect(storage?.serviceCode).toBe(SC.EFS);
    expect(storage?.filters).toEqual([
      {
        Field: "productFamily",
        Value: PF.STORAGE,
        Type: "TERM_MATCH",
      },
    ]);
  });

  it("bills per GB-month as a usage-based line item", () => {
    const [storage] = efsPricingDecomposer.decompose({});
    expect(storage?.kind).toBe(K.USAGE_BASED);
    expect(storage?.unit).toBe(PricingUnit.GB);
    expect(storage?.priceUnit).toBe(PriceUnit.PER_GB_MONTH);
  });

  describe("ThroughputMode handling (f) 2026-04-09", () => {
    it("emits only Standard storage for ThroughputMode=bursting (default)", () => {
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "bursting",
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.label).toBe(LineItemLabel.STORAGE);
    });

    it("emits only Standard storage for ThroughputMode=elastic", () => {
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "elastic",
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.label).toBe(LineItemLabel.STORAGE);
    });

    it("emits a second Provisioned throughput line when ThroughputMode=provisioned", () => {
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "provisioned",
        ProvisionedThroughputInMibps: 100,
      });
      expect(items).toHaveLength(2);

      const provisioned = items.find(
        (i) => i.label === LineItemLabel.PROVISIONED_THROUGHPUT,
      );
      expect(provisioned).toBeDefined();
      expect(provisioned?.kind).toBe(K.FIXED);
      expect(provisioned?.quantity).toBe(100);
      expect(provisioned?.unit).toBe(PricingUnit.MIBPS);
      expect(provisioned?.priceUnit).toBe(PriceUnit.PER_MIBPS_MONTH);
      expect(provisioned?.serviceCode).toBe(SC.EFS);
      expect(provisioned?.description).toMatch(/100 MiB\/s committed/);
    });

    it("quantity falls back to 0 when ProvisionedThroughputInMibps is missing", () => {
      // Surfacing the line item with quantity=0 is still valuable —
      // the plan box shows the user there's a provisioned cost
      // component that needs a concrete number.
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "provisioned",
      });
      expect(items).toHaveLength(2);
      const provisioned = items.find(
        (i) => i.label === LineItemLabel.PROVISIONED_THROUGHPUT,
      );
      expect(provisioned?.quantity).toBe(0);
    });

    it("accepts ProvisionedThroughputInMibps as a numeric string (CLI coercion safety)", () => {
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "provisioned",
        ProvisionedThroughputInMibps: "250",
      });
      const provisioned = items.find(
        (i) => i.label === LineItemLabel.PROVISIONED_THROUGHPUT,
      );
      expect(provisioned?.quantity).toBe(250);
    });

    it("is case-insensitive on ThroughputMode (CFN accepts mixed case)", () => {
      const lower = efsPricingDecomposer.decompose({
        ThroughputMode: "provisioned",
        ProvisionedThroughputInMibps: 50,
      });
      const upper = efsPricingDecomposer.decompose({
        ThroughputMode: "PROVISIONED",
        ProvisionedThroughputInMibps: 50,
      });
      expect(lower).toHaveLength(2);
      expect(upper).toHaveLength(2);
    });

    it("does NOT emit provisioned line when ProvisionedThroughputInMibps is set but mode is bursting", () => {
      // Guard against accidentally emitting a line for a
      // nonsensical config where the user left throughput=bursting
      // but set a value — CCAPI would silently ignore it, and so
      // should the cost display.
      const items = efsPricingDecomposer.decompose({
        ThroughputMode: "bursting",
        ProvisionedThroughputInMibps: 100,
      });
      expect(items).toHaveLength(1);
    });
  });

  it("ignores BackupPolicy (backup is billed through AWSBackup, not AmazonEFS)", () => {
    const withBackup = efsPricingDecomposer.decompose({
      BackupPolicy: { Status: "ENABLED" },
    });
    const withoutBackup = efsPricingDecomposer.decompose({
      BackupPolicy: { Status: "DISABLED" },
    });
    expect(withBackup).toHaveLength(1);
    expect(withoutBackup).toHaveLength(1);
  });
});
