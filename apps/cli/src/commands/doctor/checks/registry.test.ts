/**
 * Tests for the doctor `checkRegistry` function (PR-013 / W24c-S3).
 *
 * Covers:
 *   - [ok] when registry responds with HTTP 200
 *   - [!] when registry responds with a non-OK HTTP status (e.g. 403)
 *   - [!] with HTTPS_PROXY tip when the request times out (AbortError)
 *   - [!] when fetch throws a network error (ENOTFOUND)
 *   - Section shape: name "npm registry", sub-checks array, status rollup
 *   - skipRegistry path produces "skipped" placeholder (via runner)
 */

import { describe, it, expect, vi } from "vitest";
import { checkRegistry } from "./registry.js";
import type { RegistryFetchFn } from "./registry.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock fetchImpl that resolves with the given HTTP status.
 * `ok` mirrors real fetch semantics: true for 200-299.
 */
function makeFetchOk(status: number = 200): RegistryFetchFn {
  return vi
    .fn()
    .mockResolvedValue({ ok: status >= 200 && status < 300, status });
}

/**
 * Build a mock fetchImpl that rejects with the given error.
 */
function makeFetchError(err: Error): RegistryFetchFn {
  return vi.fn().mockRejectedValue(err);
}

// ── section shape ─────────────────────────────────────────────────────────────

describe("checkRegistry — section shape", () => {
  it("returns a section named 'npm registry'", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(section.name).toBe("npm registry");
  });

  it("section has a non-empty subs array", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(Array.isArray(section.subs)).toBe(true);
    expect(section.subs.length).toBeGreaterThan(0);
  });

  it("section status is 'ok' on success", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(section.status).toBe("ok");
  });
});

// ── ok path ───────────────────────────────────────────────────────────────────

describe("checkRegistry — ok (registry reachable)", () => {
  it("sub-check status is 'ok' when fetch returns HTTP 200", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(section.subs[0]?.status).toBe("ok");
  });

  it("sub-check detail mentions the registry URL", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(section.subs[0]?.detail).toContain("registry.npmjs.org");
  });

  it("sub-check detail includes the HTTP status code", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(200),
    });
    expect(section.subs[0]?.detail).toContain("200");
  });
});

// ── warn paths ────────────────────────────────────────────────────────────────

describe("checkRegistry — warn (registry unreachable)", () => {
  it("sub-check status is 'warn' when fetch returns non-OK HTTP status", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(403),
    });
    expect(section.subs[0]?.status).toBe("warn");
  });

  it("section status is 'warn' when fetch returns non-OK HTTP status", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(403),
    });
    expect(section.status).toBe("warn");
  });

  it("sub-check detail includes the non-OK HTTP status on proxy-block", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(403),
    });
    expect(section.subs[0]?.detail).toContain("403");
  });

  it("sub-check detail includes HTTPS_PROXY hint on non-OK response", async () => {
    const section = await checkRegistry({
      fetchImpl: makeFetchOk(403),
    });
    expect(section.subs[0]?.detail).toContain("HTTPS_PROXY");
  });

  it("sub-check status is 'warn' on AbortError (timeout)", async () => {
    const abortErr = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const section = await checkRegistry({
      fetchImpl: makeFetchError(abortErr),
      timeoutMs: 1,
    });
    expect(section.subs[0]?.status).toBe("warn");
  });

  it("sub-check detail mentions 'timed out' on AbortError", async () => {
    const abortErr = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const section = await checkRegistry({
      fetchImpl: makeFetchError(abortErr),
      timeoutMs: 3000,
    });
    expect(section.subs[0]?.detail).toContain("timed out");
  });

  it("sub-check detail includes HTTPS_PROXY hint on AbortError", async () => {
    const abortErr = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const section = await checkRegistry({
      fetchImpl: makeFetchError(abortErr),
    });
    expect(section.subs[0]?.detail).toContain("HTTPS_PROXY");
  });

  it("sub-check status is 'warn' on ENOTFOUND network error", async () => {
    const netErr = Object.assign(new Error("ENOTFOUND registry.npmjs.org"), {
      code: "ENOTFOUND",
    });
    const section = await checkRegistry({
      fetchImpl: makeFetchError(netErr),
    });
    expect(section.subs[0]?.status).toBe("warn");
  });

  it("sub-check detail includes HTTPS_PROXY hint on network error", async () => {
    const netErr = Object.assign(new Error("ENOTFOUND registry.npmjs.org"), {
      code: "ENOTFOUND",
    });
    const section = await checkRegistry({
      fetchImpl: makeFetchError(netErr),
    });
    expect(section.subs[0]?.detail).toContain("HTTPS_PROXY");
  });

  it("sub-check detail includes ASSIGNEE_NO_UPDATE_CHECK opt-out on network error", async () => {
    const netErr = new Error("connection refused");
    const section = await checkRegistry({
      fetchImpl: makeFetchError(netErr),
    });
    expect(section.subs[0]?.detail).toContain("ASSIGNEE_NO_UPDATE_CHECK");
  });
});
