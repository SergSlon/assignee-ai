import { describe, it, expect } from "vitest";
import { formatPerUnit, formatUnitSuffix } from "./unit-label.js";

describe("formatUnitSuffix", () => {
  it("pluralises simple nouns", () => {
    expect(formatUnitSuffix("req")).toBe("/M reqs");
    expect(formatUnitSuffix("msg")).toBe("/M msgs");
    expect(formatUnitSuffix("min")).toBe("/M mins");
  });

  it("pluralises 'sh' nouns with 'es'", () => {
    expect(formatUnitSuffix("publish")).toBe("/M publishes");
  });

  it("does not double-pluralise already-plural nouns", () => {
    expect(formatUnitSuffix("reqs")).toBe("/M reqs");
    expect(formatUnitSuffix("publishes")).toBe("/M publishes");
  });

  it("respects plural=false", () => {
    expect(formatUnitSuffix("req", false)).toBe("/M req");
    expect(formatUnitSuffix("publish", false)).toBe("/M publish");
  });

  it("handles multi-word unit nouns", () => {
    expect(formatUnitSuffix("read req")).toBe("/M read reqs");
    expect(formatUnitSuffix("write req")).toBe("/M write reqs");
  });
});

// Probe variation A — single canonical format
describe("formatPerUnit — variation A: canonical format", () => {
  it("produces dollar-sign + decimal + /M suffix", () => {
    const result = formatPerUnit(0.4, "req");
    expect(result).toMatch(/^\$\d+\.\d+\/M [a-z ]+$/);
  });

  it("all 5 decomposer unit types match the canonical regex", () => {
    const canonical = /^\$\d+\.\d+\/M [a-z ]+$/;
    expect(formatPerUnit(0.0000004, "req")).toMatch(canonical);
    expect(formatPerUnit(0.0000005, "publish")).toMatch(canonical);
    expect(formatPerUnit(0.00000025, "read req")).toMatch(canonical);
    expect(formatPerUnit(0.00000025, "write req")).toMatch(canonical);
    expect(formatPerUnit(0.0000002, "req")).toMatch(canonical); // Lambda reqs
  });
});

// Probe variation B — pluralisation
describe("formatPerUnit — variation B: pluralisation", () => {
  it("formatPerUnit defaults to plural", () => {
    expect(formatPerUnit(0.4, "request")).toBe("$0.40/M requests");
  });

  it("formatPerUnit with plural=false omits the 's'", () => {
    expect(formatPerUnit(0.4, "request", false)).toBe("$0.40/M request");
  });
});

// Probe variation C — large values and no tilde
describe("formatPerUnit — variation C: large values, no tilde", () => {
  it("value >= 1 uses 2 decimal places, no tilde", () => {
    expect(formatPerUnit(1.03, "request")).toBe("$1.03/M requests");
  });

  it("value between 0.01 and 1 uses 2 decimal places", () => {
    expect(formatPerUnit(0.5, "request")).toBe("$0.50/M requests");
    expect(formatPerUnit(0.4, "request")).toBe("$0.40/M requests");
  });

  it("value between 0.0001 and 0.01 uses 4 decimal places", () => {
    expect(formatPerUnit(0.001, "request")).toBe("$0.0010/M requests");
    expect(formatPerUnit(0.0025, "request")).toBe("$0.0025/M requests");
  });

  it("very small value uses enough places to be non-zero", () => {
    const result = formatPerUnit(0.0000004, "request");
    // Should not be "$0.0000/M requests" — needs enough decimals
    expect(result).not.toContain("$0.0000/");
    expect(result).toMatch(/^\$0\.0+[1-9]/);
  });
});

// Ensure PriceUnit constants derived from formatUnitSuffix are unchanged
describe("PriceUnit constant parity (via formatUnitSuffix)", () => {
  it("formatUnitSuffix('req') matches legacy /M reqs", () => {
    expect(formatUnitSuffix("req")).toBe("/M reqs");
  });

  it("formatUnitSuffix('publish') matches legacy /M publishes", () => {
    expect(formatUnitSuffix("publish")).toBe("/M publishes");
  });

  it("formatUnitSuffix('read req') matches legacy /M read reqs", () => {
    expect(formatUnitSuffix("read req")).toBe("/M read reqs");
  });

  it("formatUnitSuffix('write req') matches legacy /M write reqs", () => {
    expect(formatUnitSuffix("write req")).toBe("/M write reqs");
  });

  it("formatUnitSuffix('msg') matches legacy /M msgs", () => {
    expect(formatUnitSuffix("msg")).toBe("/M msgs");
  });

  it("formatUnitSuffix('min') matches legacy /M mins", () => {
    expect(formatUnitSuffix("min")).toBe("/M mins");
  });
});
