/**
 * Tests for url-validator (W5-03, P007-tech → L4-S09).
 * Covers all acceptance-criteria cases from the story spec.
 */
import { describe, it, expect } from "vitest";
import { validateUrl, assertValidUrl } from "./url-validator.js";

describe("validateUrl", () => {
  describe("HTTPS — always accepted", () => {
    it("accepts https://example.com", () => {
      expect(
        validateUrl("https://example.com", { allowLocalhostHttp: false }),
      ).toEqual({
        valid: true,
      });
    });

    it("accepts https://ollama.internal:11434 (W5-03 AC)", () => {
      expect(
        validateUrl("https://ollama.internal:11434", {
          allowLocalhostHttp: true,
        }),
      ).toEqual({ valid: true });
    });

    it("accepts https://api.assignee.ai/v1", () => {
      expect(
        validateUrl("https://api.assignee.ai/v1", {
          allowLocalhostHttp: false,
        }),
      ).toEqual({ valid: true });
    });
  });

  describe("http://localhost — accepted only when allowLocalhostHttp: true", () => {
    it("accepts http://localhost:11434 when allowLocalhostHttp: true (W5-03 AC)", () => {
      expect(
        validateUrl("http://localhost:11434", { allowLocalhostHttp: true }),
      ).toEqual({ valid: true });
    });

    it("accepts http://127.0.0.1:11434 when allowLocalhostHttp: true", () => {
      expect(
        validateUrl("http://127.0.0.1:11434", { allowLocalhostHttp: true }),
      ).toEqual({ valid: true });
    });

    it("rejects http://localhost:11434 when allowLocalhostHttp: false", () => {
      const result = validateUrl("http://localhost:11434", {
        allowLocalhostHttp: false,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("only https://");
    });
  });

  describe("plaintext HTTP to non-localhost — rejected", () => {
    it("rejects http://example.com (ASSIGNEE_SAAS_URL=http:// W5-03 AC)", () => {
      const result = validateUrl("http://example.com", {
        allowLocalhostHttp: false,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('"http://example.com" rejected');
    });

    it("rejects http://192.168.1.100:11434 (non-localhost, W5-03 AC)", () => {
      const result = validateUrl("http://192.168.1.100:11434", {
        allowLocalhostHttp: true,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('"http://192.168.1.100:11434" rejected');
    });

    it("rejects http://10.0.0.1:8080 even when allowLocalhostHttp: true", () => {
      const result = validateUrl("http://10.0.0.1:8080", {
        allowLocalhostHttp: true,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("arbitrary schemes — rejected", () => {
    it("rejects ftp://example.com (W5-03 AC)", () => {
      const result = validateUrl("ftp://example.com", {
        allowLocalhostHttp: false,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('"ftp://example.com" rejected');
    });

    it("rejects ws://example.com", () => {
      const result = validateUrl("ws://example.com", {
        allowLocalhostHttp: false,
      });
      expect(result.valid).toBe(false);
    });

    it("rejects file:///etc/passwd", () => {
      const result = validateUrl("file:///etc/passwd", {
        allowLocalhostHttp: false,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("malformed URLs", () => {
    it("rejects plain text that is not a URL", () => {
      const result = validateUrl("not-a-url", { allowLocalhostHttp: false });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not a valid URL");
    });

    it("rejects empty string", () => {
      const result = validateUrl("", { allowLocalhostHttp: false });
      expect(result.valid).toBe(false);
    });
  });
});

describe("assertValidUrl", () => {
  it("does not throw for a valid https URL", () => {
    expect(() =>
      assertValidUrl("https://app.assignee.ai", "ASSIGNEE_SAAS_URL", {
        allowLocalhostHttp: false,
      }),
    ).not.toThrow();
  });

  it("throws with an actionable message including the env var name", () => {
    expect(() =>
      assertValidUrl("http://example.com", "ASSIGNEE_SAAS_URL", {
        allowLocalhostHttp: false,
      }),
    ).toThrow(/ASSIGNEE_SAAS_URL/);
  });

  it("throws for ftp:// with the env var name (W5-03 actionable-error AC)", () => {
    expect(() =>
      assertValidUrl("ftp://example.com", "ASSIGNEE_SAAS_URL", {
        allowLocalhostHttp: false,
      }),
    ).toThrow(/ASSIGNEE_SAAS_URL/);
  });

  it("throws for http://192.168.1.100 with the env var name (W5-03 AC)", () => {
    expect(() =>
      assertValidUrl("http://192.168.1.100:11434", "OLLAMA_BASE_URL", {
        allowLocalhostHttp: true,
      }),
    ).toThrow(/OLLAMA_BASE_URL/);
  });
});
