/**
 * Tests for budget-guard (FR-09 — budget panic limit enforcement).
 *
 * Covers:
 * - parseMonthlyUsd: free/NA sentinels, unparseable strings, and arithmetic
 *   across all supported unit suffixes (hour/day/minute/mo/GB-month/no-unit)
 *   including thousands separators and compound multi-term expressions.
 * - checkMonthlyCostBudget: every status branch (ok / warning / blocked / unparseable),
 *   including warn_only downgrade and sentinel short-circuits.
 */

import { describe, it, expect } from "vitest";
import type { ConfigBudget } from "@assignee/core";
import {
  parseMonthlyUsd,
  checkMonthlyCostBudget,
  FREE_OR_NA,
  UNPARSEABLE,
} from "./budget-guard.js";

describe("parseMonthlyUsd", () => {
  describe("FREE_OR_NA sentinel", () => {
    it("returns FREE_OR_NA for undefined", () => {
      expect(parseMonthlyUsd(undefined)).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for empty string", () => {
      expect(parseMonthlyUsd("")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for whitespace-only string", () => {
      expect(parseMonthlyUsd("   ")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for 'Free'", () => {
      expect(parseMonthlyUsd("Free")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for 'N/A'", () => {
      expect(parseMonthlyUsd("N/A")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for 'na' (lowercase)", () => {
      expect(parseMonthlyUsd("na")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for 'unavailable'", () => {
      expect(parseMonthlyUsd("unavailable")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for '$0'", () => {
      expect(parseMonthlyUsd("$0")).toBe(FREE_OR_NA);
    });
    it("returns FREE_OR_NA for '$0.00'", () => {
      expect(parseMonthlyUsd("$0.00")).toBe(FREE_OR_NA);
    });
  });

  describe("UNPARSEABLE sentinel", () => {
    it("returns UNPARSEABLE for 'See pricing calculator'", () => {
      expect(parseMonthlyUsd("See pricing calculator")).toBe(UNPARSEABLE);
    });
    it("returns UNPARSEABLE for 'Contact sales'", () => {
      expect(parseMonthlyUsd("Contact sales")).toBe(UNPARSEABLE);
    });
    it("returns UNPARSEABLE for 'unknown'", () => {
      expect(parseMonthlyUsd("unknown")).toBe(UNPARSEABLE);
    });
    it("returns UNPARSEABLE for random text without a $ sign", () => {
      expect(parseMonthlyUsd("xyz")).toBe(UNPARSEABLE);
    });
  });

  describe("numeric parsing — single term", () => {
    it("parses '$0.0104/hour' as hourly × 730", () => {
      const result = parseMonthlyUsd("$0.0104/hour");
      expect(result).toBeCloseTo(7.592, 5);
    });
    it("parses '$0.0104/hr' (hr alias)", () => {
      const result = parseMonthlyUsd("$0.0104/hr");
      expect(result).toBeCloseTo(7.592, 5);
    });
    it("parses '$7.59/mo' directly", () => {
      expect(parseMonthlyUsd("$7.59/mo")).toBeCloseTo(7.59, 5);
    });
    it("parses '$7.59/month' directly", () => {
      expect(parseMonthlyUsd("$7.59/month")).toBeCloseTo(7.59, 5);
    });
    it("parses '$0.023/GB-month' directly (no hour/day scaling)", () => {
      expect(parseMonthlyUsd("$0.023/GB-month")).toBeCloseTo(0.023, 5);
    });
    it("parses '$0.10/day' as daily × 30", () => {
      const result = parseMonthlyUsd("$0.10/day");
      expect(result).toBeCloseTo(3, 5);
    });
    it("parses '$0.001/minute' as minutes × 43200", () => {
      const result = parseMonthlyUsd("$0.001/minute");
      expect(result).toBeCloseTo(43.2, 5);
    });
    it("parses '$0.10' with no unit as monthly direct", () => {
      expect(parseMonthlyUsd("$0.10")).toBeCloseTo(0.1, 5);
    });
    it("parses '$0.05/hour' as 36.5 monthly", () => {
      expect(parseMonthlyUsd("$0.05/hour")).toBeCloseTo(36.5, 5);
    });
  });

  describe("thousands separators", () => {
    it("parses '$1,200.50/mo' with decimal and comma", () => {
      expect(parseMonthlyUsd("$1,200.50/mo")).toBeCloseTo(1200.5, 5);
    });
    it("parses '$1,200/mo' without decimal", () => {
      expect(parseMonthlyUsd("$1,200/mo")).toBeCloseTo(1200, 5);
    });
  });

  describe("compound multi-term expressions", () => {
    it("sums '$0.023/GB-month + $0.0004/request' (both monthly direct)", () => {
      const result = parseMonthlyUsd("$0.023/GB-month + $0.0004/request");
      expect(result).toBeCloseTo(0.0234, 6);
    });
    it("sums '$0.0104/hour + $0.023/GB-month' applying unit per term", () => {
      const result = parseMonthlyUsd("$0.0104/hour + $0.023/GB-month");
      expect(result).toBeCloseTo(7.615, 4);
    });
  });
});

describe("checkMonthlyCostBudget", () => {
  it("returns ok when no budget is configured (undefined budget)", () => {
    const result = checkMonthlyCostBudget("$50/mo", undefined);
    expect(result.status).toBe("ok");
  });

  it("returns ok when monthly_limit_usd is undefined", () => {
    const budget: ConfigBudget = { warn_only: false };
    const result = checkMonthlyCostBudget("$50/mo", budget);
    expect(result.status).toBe("ok");
  });

  it("returns ok when cost is under the limit", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10 };
    const result = checkMonthlyCostBudget("$5/mo", budget);
    expect(result.status).toBe("ok");
  });

  it("returns blocked when cost exceeds the limit (warn_only=false)", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10, warn_only: false };
    const result = checkMonthlyCostBudget("$50/mo", budget);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.limit).toBe(10);
      expect(result.estimated).toBeCloseTo(50, 5);
      expect(result.message).toContain("$50.00");
      expect(result.message).toContain("$10.00");
    }
  });

  it("returns warning when cost exceeds the limit and warn_only=true", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10, warn_only: true };
    const result = checkMonthlyCostBudget("$50/mo", budget);
    expect(result.status).toBe("warning");
    if (result.status === "warning") {
      expect(result.limit).toBe(10);
      expect(result.estimated).toBeCloseTo(50, 5);
      expect(result.message).toContain("$50.00");
      expect(result.message).toContain("$10.00");
    }
  });

  it("returns ok when cost is 'Free' even with a limit", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10 };
    expect(checkMonthlyCostBudget("Free", budget).status).toBe("ok");
  });

  it("returns ok when cost is 'N/A' even with a limit", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10 };
    expect(checkMonthlyCostBudget("N/A", budget).status).toBe("ok");
  });

  it("returns unparseable when cost is 'See pricing calculator'", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10 };
    const result = checkMonthlyCostBudget("See pricing calculator", budget);
    expect(result.status).toBe("unparseable");
    if (result.status === "unparseable") {
      expect(result.limit).toBe(10);
      expect(result.rawCost).toBe("See pricing calculator");
      expect(result.message).toContain("See pricing calculator");
      expect(result.message).toContain("$10.00");
    }
  });

  it("returns ok when cost is undefined (treated as FREE_OR_NA)", () => {
    const budget: ConfigBudget = { monthly_limit_usd: 10 };
    expect(checkMonthlyCostBudget(undefined, budget).status).toBe("ok");
  });

  it("returns ok when a compound hourly cost sits just under the limit", () => {
    // 0.0104 × 730 = 7.592 ≤ 8
    const budget: ConfigBudget = { monthly_limit_usd: 8 };
    const result = checkMonthlyCostBudget("$0.0104/hour", budget);
    expect(result.status).toBe("ok");
  });

  it("returns blocked when a compound hourly cost exceeds the limit", () => {
    // 0.0104 × 730 = 7.592 > 7
    const budget: ConfigBudget = { monthly_limit_usd: 7, warn_only: false };
    const result = checkMonthlyCostBudget("$0.0104/hour", budget);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.estimated).toBeCloseTo(7.592, 3);
      expect(result.limit).toBe(7);
    }
  });

  it("downgrades blocked to warning when warn_only=true for compound cost", () => {
    // 0.0104 × 730 = 7.592 > 5
    const budget: ConfigBudget = { monthly_limit_usd: 5, warn_only: true };
    const result = checkMonthlyCostBudget("$0.0104/hour", budget);
    expect(result.status).toBe("warning");
    if (result.status === "warning") {
      expect(result.estimated).toBeCloseTo(7.592, 3);
      expect(result.limit).toBe(5);
    }
  });
});
