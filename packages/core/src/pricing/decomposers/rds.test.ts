/**
 * Tests for RDS pricing decomposer (Story 23.2).
 * Verifies line item generation for compute (Single-AZ vs Multi-AZ), storage, and backup.
 */

import { describe, it, expect } from "vitest";
import { rdsPricingDecomposer } from "./rds.js";

describe("rdsPricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(rdsPricingDecomposer.resourceType).toBe("AWS::RDS::DBInstance");
  });

  it("returns compute + storage + backup for minimal desiredState", () => {
    const items = rdsPricingDecomposer.decompose({});

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.label)).toEqual(["Compute", "Storage", "Backup"]);
  });

  it("defaults to db.t3.micro, mysql, Single-AZ, 20GB gp3", () => {
    const items = rdsPricingDecomposer.decompose({});

    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.description).toBe("db.t3.micro");
    expect(compute.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "instanceType",
          Value: "db.t3.micro",
        }),
        expect.objectContaining({ Field: "databaseEngine", Value: "MySQL" }),
        expect.objectContaining({
          Field: "deploymentOption",
          Value: "Single-AZ",
        }),
      ]),
    );

    const storage = items.find((i) => i.label === "Storage")!;
    expect(storage.quantity).toBe(20);
    expect(storage.description).toBe("20 GB gp3");
  });

  it("uses specified instance class and engine", () => {
    const items = rdsPricingDecomposer.decompose({
      DBInstanceClass: "db.r6g.large",
      Engine: "postgres",
    });

    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "instanceType",
          Value: "db.r6g.large",
        }),
        expect.objectContaining({
          Field: "databaseEngine",
          Value: "PostgreSQL",
        }),
      ]),
    );
  });

  it("Single-AZ compute uses Single-AZ deployment filter", () => {
    const items = rdsPricingDecomposer.decompose({
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      MultiAZ: false,
    });

    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.description).toBe("db.t3.micro");
    expect(compute.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "deploymentOption",
          Value: "Single-AZ",
        }),
      ]),
    );
  });

  it("Multi-AZ compute uses Multi-AZ deployment filter and description", () => {
    const items = rdsPricingDecomposer.decompose({
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      MultiAZ: true,
    });

    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.description).toBe("db.t3.micro (Multi-AZ)");
    expect(compute.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "deploymentOption",
          Value: "Multi-AZ",
        }),
      ]),
    );
  });

  it("storage reflects AllocatedStorage and StorageType", () => {
    const items = rdsPricingDecomposer.decompose({
      AllocatedStorage: "100",
      StorageType: "io1",
    });

    const storage = items.find((i) => i.label === "Storage")!;
    expect(storage.quantity).toBe(100);
    expect(storage.description).toBe("100 GB io1");
    expect(storage.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Database Storage",
        }),
        expect.objectContaining({
          Field: "volumeType",
          Value: "Provisioned IOPS (SSD)",
        }),
      ]),
    );
  });

  it("storage deployment option follows Multi-AZ setting", () => {
    const items = rdsPricingDecomposer.decompose({
      MultiAZ: true,
      AllocatedStorage: "50",
    });

    const storage = items.find((i) => i.label === "Storage")!;
    expect(storage.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "deploymentOption",
          Value: "Multi-AZ",
        }),
      ]),
    );
  });

  it("backup is included when BackupRetentionPeriod > 0 (default 7)", () => {
    const items = rdsPricingDecomposer.decompose({});

    // Tier C: dropped redundant toBeDefined() — find!() is at the find site
    const backup = items.find((i) => i.label === "Backup")!;
    expect(backup.kind).toBe("usage_based");
    expect(backup.quantity).toBe(20); // defaults to AllocatedStorage
    expect(backup.description).toBe("7 days retention");
    expect(backup.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "Storage Snapshot",
        }),
      ]),
    );
  });

  it("backup is excluded when BackupRetentionPeriod is 0", () => {
    const items = rdsPricingDecomposer.decompose({
      BackupRetentionPeriod: 0,
    });

    const backup = items.find((i) => i.label === "Backup");
    expect(backup).toBeUndefined();
    expect(items).toHaveLength(2);
  });

  it("backup description uses explicit retention period", () => {
    const items = rdsPricingDecomposer.decompose({
      BackupRetentionPeriod: 14,
    });

    const backup = items.find((i) => i.label === "Backup")!;
    expect(backup.description).toBe("14 days retention");
  });

  it("compute line item has extended timeout", () => {
    const items = rdsPricingDecomposer.decompose({});
    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.timeoutMs).toBe(8000);
  });

  it("maps engine names correctly", () => {
    const engines: Array<[string, string]> = [
      ["mysql", "MySQL"],
      ["postgres", "PostgreSQL"],
      ["mariadb", "MariaDB"],
      ["aurora-mysql", "Aurora MySQL"],
      ["aurora-postgresql", "Aurora PostgreSQL"],
    ];

    for (const [input, expected] of engines) {
      const items = rdsPricingDecomposer.decompose({ Engine: input });
      const compute = items.find((i) => i.label === "Compute")!;
      expect(compute.filters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Field: "databaseEngine", Value: expected }),
        ]),
      );
    }
  });
});
