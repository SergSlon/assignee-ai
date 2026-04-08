import { describe, it, expect } from "vitest";
import { efsPricingDecomposer } from "./efs.js";
import {
  PricingServiceCode as SC,
  PricingProductFamily as PF,
  PricingKind as K,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";
import { PricingUnit } from "../units.js";

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

  it("ignores ThroughputMode / ProvisionedThroughputInMibps (deferred — see decomposer header comment)", () => {
    // When we eventually ship the provisioned throughput line item, this
    // test will flip to expect length 2. Until then, the elastic/bursting/
    // provisioned modes all produce the same single-line breakdown.
    const bursting = efsPricingDecomposer.decompose({
      ThroughputMode: "bursting",
    });
    const provisioned = efsPricingDecomposer.decompose({
      ThroughputMode: "provisioned",
      ProvisionedThroughputInMibps: 100,
    });
    const elastic = efsPricingDecomposer.decompose({
      ThroughputMode: "elastic",
    });
    expect(bursting).toHaveLength(1);
    expect(provisioned).toHaveLength(1);
    expect(elastic).toHaveLength(1);
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
