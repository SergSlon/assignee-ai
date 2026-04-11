import { describe, it, expect } from "vitest";
import { rdsPricingStrategy } from "./rds.js";

describe("rdsPricingStrategy", () => {
  describe("estimateLocal", () => {
    it("returns null perMonth and N/A label", () => {
      const result = rdsPricingStrategy.estimateLocal();
      expect(result).toEqual({
        perMonth: null,
        label: "N/A",
        source: "fallback",
      });
    });
  });

  describe("mcpConfig", () => {
    it("uses defaults (db.t3.micro, mysql) when no desiredState", () => {
      const config = rdsPricingStrategy.mcpConfig!();
      expect(config!.serviceCode).toBe("AmazonRDS");
      expect(config!.unit).toBe("/hour");
      expect(config!.timeoutMs).toBe(8000);
      const instanceFilter = config!.filters.find(
        (f) => f.Field === "instanceType",
      );
      const engineFilter = config!.filters.find(
        (f) => f.Field === "databaseEngine",
      );
      expect(instanceFilter?.Value).toBe("db.t3.micro");
      expect(engineFilter?.Value).toBe("mysql");
    });

    it("uses DBInstanceClass and Engine from desiredState", () => {
      const config = rdsPricingStrategy.mcpConfig!({
        DBInstanceClass: "db.r5.large",
        Engine: "postgres",
      });
      const instanceFilter = config!.filters.find(
        (f) => f.Field === "instanceType",
      );
      const engineFilter = config!.filters.find(
        (f) => f.Field === "databaseEngine",
      );
      expect(instanceFilter?.Value).toBe("db.r5.large");
      expect(engineFilter?.Value).toBe("postgres");
    });

    it("includes Single-AZ deployment option filter", () => {
      const config = rdsPricingStrategy.mcpConfig!();
      const deployFilter = config!.filters.find(
        (f) => f.Field === "deploymentOption",
      );
      expect(deployFilter?.Value).toBe("Single-AZ");
    });
  });
});
