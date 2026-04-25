/**
 * Unit tests for verify-domain-ownership.ts
 *
 * All tests mock node:dns/promises — NO real DNS lookups.
 */

import { describe, it, expect, vi } from "vitest";
import {
  flattenTxtRecords,
  verifyOwnership,
} from "./verify-domain-ownership.js";

// ── flattenTxtRecords ─────────────────────────────────────────────────────────

describe("flattenTxtRecords", () => {
  it("joins chunks within each record", () => {
    const raw = [["v=spf1 ", "include:mail.example.com", " ~all"]];
    expect(flattenTxtRecords(raw)).toEqual([
      "v=spf1 include:mail.example.com ~all",
    ]);
  });

  it("handles single-chunk records", () => {
    const raw = [["assignee-verification=abc123"], ["v=spf1 ~all"]];
    expect(flattenTxtRecords(raw)).toEqual([
      "assignee-verification=abc123",
      "v=spf1 ~all",
    ]);
  });

  it("returns empty array for no records", () => {
    expect(flattenTxtRecords([])).toEqual([]);
  });

  it("handles multi-chunk concatenation correctly", () => {
    const raw = [["part1", "part2", "part3"]];
    expect(flattenTxtRecords(raw)).toEqual(["part1part2part3"]);
  });
});

// ── verifyOwnership ───────────────────────────────────────────────────────────

describe("verifyOwnership", () => {
  it("returns ok: true when proof string is found in a TXT record", async () => {
    const mockResolver = {
      resolveTxt: vi
        .fn()
        .mockResolvedValue([["assignee-verification=abc123"], ["v=spf1 ~all"]]),
    };

    const result = await verifyOwnership(
      "assignee.ai",
      "assignee-verification=abc123",
      mockResolver,
    );

    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.domain).toBe("assignee.ai");
    expect(result.proof).toBe("assignee-verification=abc123");
    expect(result.records).toContain("assignee-verification=abc123");
    expect(mockResolver.resolveTxt).toHaveBeenCalledWith("assignee.ai");
  });

  it("returns ok: false when proof string is not found", async () => {
    const mockResolver = {
      resolveTxt: vi
        .fn()
        .mockResolvedValue([["v=spf1 ~all"], ["google-site-verification=xyz"]]),
    };

    const result = await verifyOwnership(
      "assignee.ai",
      "assignee-verification=abc123",
      mockResolver,
    );

    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.records).toHaveLength(2);
  });

  it("returns ok: false when TXT records are empty", async () => {
    const mockResolver = {
      resolveTxt: vi.fn().mockResolvedValue([]),
    };

    const result = await verifyOwnership(
      "assignee.ai",
      "assignee-verification=abc123",
      mockResolver,
    );

    expect(result.ok).toBe(false);
    expect(result.records).toHaveLength(0);
  });

  it("propagates DNS error to caller", async () => {
    const mockResolver = {
      resolveTxt: vi.fn().mockRejectedValue(new Error("ESERVFAIL")),
    };

    await expect(
      verifyOwnership("broken.example.com", "proof=x", mockResolver),
    ).rejects.toThrow("ESERVFAIL");
  });

  it("finds proof when it is a substring of a TXT record", async () => {
    // e.g., the TXT record is "assignee-verification=abc123 extra-data"
    const mockResolver = {
      resolveTxt: vi
        .fn()
        .mockResolvedValue([["assignee-verification=abc123 extra-data"]]),
    };

    const result = await verifyOwnership(
      "assignee.ai",
      "assignee-verification=abc123",
      mockResolver,
    );

    expect(result.ok).toBe(true);
  });

  it("handles multi-chunk TXT records by joining before matching", async () => {
    // DNS may split long TXT records into chunks of 255 chars
    const mockResolver = {
      resolveTxt: vi
        .fn()
        .mockResolvedValue([["assignee-verification=", "abc123"]]),
    };

    const result = await verifyOwnership(
      "assignee.ai",
      "assignee-verification=abc123",
      mockResolver,
    );

    // chunks are joined: "assignee-verification=abc123" matches proof
    expect(result.ok).toBe(true);
  });
});
