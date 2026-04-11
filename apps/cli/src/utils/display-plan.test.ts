/**
 * Story 46.2 — display-plan source-suffix rendering.
 *
 * Verifies that `formatCostLine` appends the right "(live)" / "(cached)" /
 * "(estimated)" / "(from log)" / "" suffix when given each `DataSource`
 * value, and that the legacy callers (no source) still work unchanged.
 */

import { describe, it, expect } from "vitest";
import { formatCostLine } from "./display-plan.js";
import type { DataSource } from "@assignee/core";

describe("formatCostLine — source suffix rendering (Story 46.2)", () => {
  it.each([
    ["mcp", "$32.85/mo", "$32.85/mo (live)"],
    ["cached", "$32.85/mo", "$32.85/mo (cached)"],
    ["fallback", "~$32/mo", "~$32/mo (estimated)"],
    ["offline", "$10.00/month", "$10.00/month (from log)"],
    ["free", "Free", "Free"],
  ] as Array<[DataSource, string, string]>)(
    "%s source → suffix",
    (source, label, expected) => {
      expect(formatCostLine(label, source)).toBe(expected);
    },
  );

  it("returns N/A when estimatedMonthlyCost is undefined and no source", () => {
    expect(formatCostLine(undefined)).toBe("N/A");
  });

  it("returns bare N/A (no suffix) when estimatedMonthlyCost is undefined even if source is set (F7)", () => {
    // The provenance suffix only applies to a real dollar amount.
    // "N/A (live)" is contradictory — flagged by Edge Case Hunter F7
    // and Blind Hunter 7 in the Story 46.2 review pass.
    expect(formatCostLine(undefined, "mcp")).toBe("N/A");
    expect(formatCostLine(undefined, "fallback")).toBe("N/A");
    expect(formatCostLine(undefined, "free")).toBe("N/A");
  });

  it("returns the bare label when source is omitted (back-compat)", () => {
    // Existing call sites that don't yet pass a source must continue to
    // work — the suffix is a strict opt-in.
    expect(formatCostLine("$5.00/mo")).toBe("$5.00/mo");
  });

  it("free source on a non-Free label still produces no suffix", () => {
    // Defensive: a free-tier resource that for some reason renders a
    // dollar amount must NOT get an "(estimated)" tag tacked on.
    expect(formatCostLine("$0.00/mo", "free")).toBe("$0.00/mo");
  });
});
