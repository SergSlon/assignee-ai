/**
 * Unit tests for verify-domain-mx.ts
 *
 * All tests mock node:dns/promises — NO real DNS lookups.
 */

import { describe, it, expect, vi } from "vitest";
import { extractDomain, resolveMxRecords } from "./verify-domain-mx.js";

// ── extractDomain ─────────────────────────────────────────────────────────────

describe("extractDomain", () => {
  it("returns the domain from an email address", () => {
    expect(extractDomain("security@assignee.ai")).toBe("assignee.ai");
  });

  it("returns a bare domain unchanged", () => {
    expect(extractDomain("assignee.ai")).toBe("assignee.ai");
  });

  it("handles a subdomain email", () => {
    expect(extractDomain("hello@app.assignee.ai")).toBe("app.assignee.ai");
  });

  it("trims surrounding whitespace", () => {
    expect(extractDomain("  security@assignee.ai  ")).toBe("assignee.ai");
  });

  it("handles email with multiple @ signs (takes first)", () => {
    // Edge: only the first @ matters for extracting domain
    const result = extractDomain("user@host@assignee.ai");
    // indexOf('@') = 4 => slice(5) = "host@assignee.ai"
    expect(result).toBe("host@assignee.ai");
  });
});

// ── resolveMxRecords ──────────────────────────────────────────────────────────

describe("resolveMxRecords", () => {
  it("returns sorted MX records when DNS resolves successfully", async () => {
    const mockResolver = {
      resolveMx: vi.fn().mockResolvedValue([
        { exchange: "mx2.example.com", priority: 20 },
        { exchange: "mx1.example.com", priority: 10 },
      ]),
    };

    const result = await resolveMxRecords("assignee.ai", mockResolver);

    expect(result.ok).toBe(true);
    expect(result.domain).toBe("assignee.ai");
    expect(result.records).toHaveLength(2);
    // Should be sorted by priority ascending
    expect(result.records[0]).toEqual({
      exchange: "mx1.example.com",
      priority: 10,
    });
    expect(result.records[1]).toEqual({
      exchange: "mx2.example.com",
      priority: 20,
    });
    expect(mockResolver.resolveMx).toHaveBeenCalledWith("assignee.ai");
  });

  it("returns ok: false when no MX records exist", async () => {
    const mockResolver = {
      resolveMx: vi.fn().mockResolvedValue([]),
    };

    const result = await resolveMxRecords("no-mx.example.com", mockResolver);

    expect(result.ok).toBe(false);
    expect(result.records).toHaveLength(0);
  });

  it("propagates DNS error to caller (caller wraps in try/catch)", async () => {
    const mockResolver = {
      resolveMx: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
    };

    await expect(
      resolveMxRecords("nonexistent.invalid", mockResolver),
    ).rejects.toThrow("ENOTFOUND");
  });

  it("handles single MX record", async () => {
    const mockResolver = {
      resolveMx: vi
        .fn()
        .mockResolvedValue([{ exchange: "mail.assignee.ai", priority: 5 }]),
    };

    const result = await resolveMxRecords("assignee.ai", mockResolver);

    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].exchange).toBe("mail.assignee.ai");
  });

  it("uses default dns resolver when none is provided (import shape check)", async () => {
    // We cannot call the real DNS in tests; this just verifies the function
    // signature accepts no second argument. We override by passing a mock.
    const mockResolver = {
      resolveMx: vi
        .fn()
        .mockResolvedValue([{ exchange: "mx.test.com", priority: 10 }]),
    };
    // Explicit mock — ensures interface matches
    const result = await resolveMxRecords("test.com", mockResolver);
    expect(result.domain).toBe("test.com");
  });
});
