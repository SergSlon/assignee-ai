/**
 * Tests for the MCP version drift service.
 *
 * Mocks `global.fetch` so no real PyPI traffic happens. Mock payloads use
 * the actual `{info: {version: "..."}}` shape that PyPI returns — verified
 * against the live API on 2026-04-11. Per the project test rules: real
 * data shapes only, all branches covered, no placeholder fixtures.
 *
 * @see Story 45.6
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePin,
  compareVersions,
  fetchLatestVersion,
  checkMcpVersions,
  formatScriptRow,
  computeScriptExitCode,
  runMcpVersionScript,
  type McpVersionCheckResult,
} from "../mcp-version-check.js";
import { MCP_PINS } from "../../config/mcp-servers.js";

// ── parsePin ────────────────────────────────────────────────────────────────

describe("parsePin", () => {
  it.each(Object.entries(MCP_PINS))(
    "round-trips every MCP_PINS entry: %s = %s",
    (_key, pin) => {
      const { packageName, pinnedVersion } = parsePin(pin);
      // The parsed parts must reconstruct the original pin verbatim — this
      // catches a bug where the splitter loses the dotted package prefix.
      expect(`${packageName}@${pinnedVersion}`).toBe(pin);
      // Sanity: package names contain dots and version starts with a digit.
      expect(packageName).toContain(".");
      expect(pinnedVersion).toMatch(/^\d/);
    },
  );

  it("splits on the LAST @ so dotted package prefixes survive", () => {
    // The "awslabs." prefix has dots but no `@`; our pin format guarantees
    // a single trailing `@<version>`. lastIndexOf("@") is the safe split.
    const { packageName, pinnedVersion } = parsePin(
      "awslabs.aws-pricing-mcp-server@1.0.27",
    );
    expect(packageName).toBe("awslabs.aws-pricing-mcp-server");
    expect(pinnedVersion).toBe("1.0.27");
  });

  it("throws on a pin missing the @ separator", () => {
    expect(() => parsePin("awslabs.foo")).toThrow(/Invalid MCP pin format/);
  });

  it("throws on a pin with a trailing @ but no version", () => {
    expect(() => parsePin("awslabs.foo@")).toThrow(/Invalid MCP pin format/);
  });
});

// ── compareVersions ─────────────────────────────────────────────────────────

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.27", "1.0.27")).toBe(0);
    expect(compareVersions("0.1.7", "0.1.7")).toBe(0);
  });

  it("returns -1 when first version is smaller", () => {
    expect(compareVersions("1.0.5", "1.0.27")).toBe(-1);
    expect(compareVersions("1.0.27", "1.1.0")).toBe(-1);
    expect(compareVersions("0.0.17", "0.1.0")).toBe(-1);
  });

  it("returns 1 when first version is larger", () => {
    expect(compareVersions("1.0.27", "1.0.5")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  it("compares numerically not lexicographically (1.0.27 > 1.0.5)", () => {
    // Lexicographic compare would say "1.0.27" < "1.0.5" because "27" < "5"
    // as strings. The integer compare must give us the correct ordering.
    expect(compareVersions("1.0.27", "1.0.5")).toBe(1);
    expect(compareVersions("1.0.5", "1.0.27")).toBe(-1);
  });

  it("treats trailing missing components as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("2", "2.0.0")).toBe(0);
  });

  it("falls back to string compare deterministically for non-numeric components", () => {
    // Pre-release tags aren't currently used by any awslabs MCP package
    // (verified 2026-04-11). If one ever appears, the fallback must:
    //   (a) not throw
    //   (b) be deterministic in either direction
    //   (c) be consistent under swap (a==b is symmetric, a<b implies b>a)
    // The actual ordering is *intentionally* not specified — pre-release
    // semantics need a real semver/PEP 440 lib for correctness, which is
    // out of scope here. The point of this branch is "don't crash and
    // don't claim two distinct strings are equal".
    const cmp = compareVersions("1.0.0rc1", "1.0.0");
    expect([-1, 0, 1]).toContain(cmp);
    expect(cmp).not.toBe(0); // distinct strings must compare unequal
    // Symmetry under swap.
    expect(compareVersions("1.0.0", "1.0.0rc1")).toBe(-cmp);
  });

  it("compares length-asymmetric numeric versions correctly", () => {
    // 1.0.0.1 has more segments than 1.0.0; missing components are zero,
    // so 1.0.0.1 > 1.0.0.
    expect(compareVersions("1.0.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0.1")).toBe(-1);
    // 2 vs 2.0.0.0 — both reduce to 2.0.0.0, equal.
    expect(compareVersions("2", "2.0.0.0")).toBe(0);
    // Different MINOR with extra trailing components on the smaller side.
    expect(compareVersions("1.10.0.0", "1.2.99.99")).toBe(1);
  });

  it("treats leading-zero numeric components as the equivalent integer", () => {
    // PyPI versions don't use leading zeros, but parseInt strips them
    // anyway. Verify the behavior is consistent so a future bump like
    // "1.01.0" doesn't accidentally compare unequal to "1.1.0".
    expect(compareVersions("1.01.0", "1.1.0")).toBe(0);
    expect(compareVersions("01.0.0", "1.0.0")).toBe(0);
  });
});

// ── fetchLatestVersion ──────────────────────────────────────────────────────

describe("fetchLatestVersion", () => {
  // We `vi.fn()` a fresh fetch mock and assign it directly so the spy's
  // mockImplementation accepts the typed `(input, init)` signature without
  // tripping vitest's structural-narrowing on the global.
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeOkResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns info.version from a well-formed PyPI payload", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({
        info: {
          name: "awslabs.aws-pricing-mcp-server",
          version: "1.0.30",
          summary: "AWS Pricing MCP server",
          yanked: false,
        },
        releases: { "1.0.30": [], "1.0.27": [] },
      }),
    );

    const controller = new AbortController();
    const result = await fetchLatestVersion(
      "awslabs.aws-pricing-mcp-server",
      controller.signal,
    );
    expect(result).toBe("1.0.30");
    // Verify the URL is correctly assembled (pkg name URL-encoded).
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://pypi.org/pypi/awslabs.aws-pricing-mcp-server/json",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("throws on a non-200 response with status text in the error", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    const controller = new AbortController();
    await expect(
      fetchLatestVersion("awslabs.does-not-exist", controller.signal),
    ).rejects.toThrow(/PyPI fetch failed: 404 Not Found/);
  });

  it("throws when response body is malformed JSON", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("not-json-at-all", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const controller = new AbortController();
    await expect(
      fetchLatestVersion("awslabs.foo", controller.signal),
    ).rejects.toThrow(/PyPI returned malformed JSON/);
  });

  it("throws when payload is missing the info object", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ releases: {} }));

    const controller = new AbortController();
    await expect(
      fetchLatestVersion("awslabs.foo", controller.signal),
    ).rejects.toThrow(/missing `info` object/);
  });

  it("throws when info.version is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      makeOkResponse({ info: { name: "awslabs.foo" } }),
    );

    const controller = new AbortController();
    await expect(
      fetchLatestVersion("awslabs.foo", controller.signal),
    ).rejects.toThrow(/`info.version` is not a non-empty string/);
  });

  it("throws when info.version is the empty string", async () => {
    fetchSpy.mockResolvedValueOnce(makeOkResponse({ info: { version: "" } }));

    const controller = new AbortController();
    await expect(
      fetchLatestVersion("awslabs.foo", controller.signal),
    ).rejects.toThrow(/`info.version` is not a non-empty string/);
  });

  it("propagates an aborted-signal error from the underlying fetch", async () => {
    // When the controller fires, the native fetch implementation rejects
    // with an AbortError. We simulate that here so the timeout path is
    // covered without sleeping.
    fetchSpy.mockImplementationOnce(
      async (_url: unknown, init: { signal?: AbortSignal } = {}) => {
        if (init.signal?.aborted) {
          throw new Error("The operation was aborted");
        }
        throw new Error("test setup: signal was not aborted");
      },
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchLatestVersion("awslabs.foo", controller.signal),
    ).rejects.toThrow(/aborted/);
  });
});

// ── checkMcpVersions (orchestrator) ─────────────────────────────────────────

describe("checkMcpVersions", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Build a JSON Response for a given pinned version (== latest). */
  function okResponseFor(version: string): Response {
    return new Response(JSON.stringify({ info: { version } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns one row per MCP_PINS entry", async () => {
    // Echo each request's pinned version back as the "latest" so all are
    // up-to-date. The fetch spy receives one call per pin in arbitrary
    // order, so we drive it via a URL → version map.
    const expected = new Map<string, string>();
    for (const pin of Object.values(MCP_PINS)) {
      const at = pin.lastIndexOf("@");
      expected.set(pin.slice(0, at), pin.slice(at + 1));
    }
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const match = url.match(/\/pypi\/(.+?)\/json/);
      if (!match) throw new Error(`unexpected fetch URL: ${url}`);
      const pkg = decodeURIComponent(match[1]!);
      const version = expected.get(pkg);
      if (!version) throw new Error(`no fixture for ${pkg}`);
      return okResponseFor(version);
    });

    const results = await checkMcpVersions();
    expect(results.length).toBe(Object.keys(MCP_PINS).length);
    expect(results.every((r) => r.status === "up-to-date")).toBe(true);
    // Every row's pinnedVersion === latestVersion.
    for (const r of results) {
      expect(r.latestVersion).toBe(r.pinnedVersion);
      expect(r.error).toBeUndefined();
    }
  });

  it('reports status="up-to-date" when latest < pinned (upstream rollback / yanked release)', async () => {
    // Drive a single MCP — return a version OLDER than the pinned one.
    // We're holding a newer release than PyPI currently advertises (rare
    // but legitimate: maintainers occasionally yank a bad release). We
    // must NOT report this as "behind" — that would cause CI to flap and
    // mislead the human reviewer about which direction to bump.
    const aPin = Object.values(MCP_PINS)[0]!;
    const aPkg = aPin.slice(0, aPin.lastIndexOf("@"));
    const aPinned = aPin.slice(aPin.lastIndexOf("@") + 1);
    // Decrement the patch component by 1 to simulate a yanked latest.
    const parts = aPinned.split(".").map((s) => Number.parseInt(s, 10));
    parts[parts.length - 1] = Math.max(0, (parts[parts.length - 1] ?? 1) - 1);
    const olderLatest = parts.join(".");

    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const match = url.match(/\/pypi\/(.+?)\/json/);
      const pkg = decodeURIComponent(match![1]!);
      const pin = Object.values(MCP_PINS).find((p) => p.startsWith(pkg + "@"))!;
      const pinned = pin.slice(pin.lastIndexOf("@") + 1);
      // Only the first MCP gets the older-latest treatment; the others
      // return their own pinned version (== latest, up-to-date).
      const version = pkg === aPkg ? olderLatest : pinned;
      return new Response(JSON.stringify({ info: { version } }), {
        status: 200,
      });
    });

    const results = await checkMcpVersions();
    const targetRow = results.find((r) => r.packageName === aPkg);
    expect(targetRow).toBeDefined();
    expect(targetRow?.status).toBe("up-to-date");
    expect(targetRow?.latestVersion).toBe(olderLatest);
    // Other rows must remain up-to-date too — directional bug must not
    // bleed into siblings.
    expect(results.every((r) => r.status === "up-to-date")).toBe(true);
  });

  it('reports status="behind" when latest > pinned', async () => {
    // Bump every pinned version's patch component by 1 so all rows drift.
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const match = url.match(/\/pypi\/(.+?)\/json/);
      if (!match) throw new Error("unexpected URL");
      const pkg = decodeURIComponent(match[1]!);
      const pin = Object.values(MCP_PINS).find((p) => p.startsWith(pkg + "@"))!;
      const pinned = pin.slice(pkg.length + 1);
      const parts = pinned.split(".").map((s) => Number.parseInt(s, 10));
      parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1;
      return okResponseFor(parts.join("."));
    });

    const results = await checkMcpVersions();
    expect(results.length).toBe(Object.keys(MCP_PINS).length);
    expect(results.every((r) => r.status === "behind")).toBe(true);
    for (const r of results) {
      expect(r.latestVersion).not.toBe(r.pinnedVersion);
      expect(r.error).toBeUndefined();
    }
  });

  it("isolates per-MCP fetch failures — one timeout does not break the others", async () => {
    // Fail the first call, succeed the rest with the pinned version.
    let callCount = 0;
    fetchSpy.mockImplementation(async (input) => {
      callCount++;
      const url = typeof input === "string" ? input : (input as URL).toString();
      const match = url.match(/\/pypi\/(.+?)\/json/);
      const pkg = decodeURIComponent(match![1]!);
      const pin = Object.values(MCP_PINS).find((p) => p.startsWith(pkg + "@"))!;
      const pinned = pin.slice(pkg.length + 1);
      if (callCount === 1) {
        throw new Error("network down");
      }
      return okResponseFor(pinned);
    });

    const results = await checkMcpVersions();
    const failed = results.filter((r) => r.status === "fetch-failed");
    const ok = results.filter((r) => r.status === "up-to-date");
    expect(failed.length).toBe(1);
    expect(ok.length).toBe(Object.keys(MCP_PINS).length - 1);
    expect(failed[0]?.error).toMatch(/network down/);
    expect(failed[0]?.latestVersion).toBeNull();
  });

  it("fires the 5s AbortController timeout on a hung fetch (drives setTimeout → abort)", async () => {
    // The previous "aborted-signal" test only proved that fetchLatestVersion
    // propagates an already-aborted signal. THIS test exercises the actual
    // setTimeout → controller.abort() wiring inside checkSinglePin.
    //
    // Use vi.useFakeTimers() so we can advance virtual time past the 5s
    // PYPI_FETCH_TIMEOUT_MS without sleeping. The mocked fetch never
    // resolves on its own — it ONLY rejects when the AbortSignal fires.
    vi.useFakeTimers();
    try {
      fetchSpy.mockImplementation(
        (_url: unknown, init: { signal?: AbortSignal } = {}) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              const reason = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            });
          }),
      );

      // Kick off the orchestrator. It should hang on the fetch until the
      // 5s timeout fires.
      const promise = checkMcpVersions();

      // Advance virtual time past the timeout so all 5 setTimeouts fire.
      await vi.advanceTimersByTimeAsync(5001);

      const results = await promise;
      expect(results.length).toBe(Object.keys(MCP_PINS).length);
      expect(results.every((r) => r.status === "fetch-failed")).toBe(true);
      // Every error message should reference the timeout we wired up.
      expect(results.every((r) => r.error?.includes("timed out"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws — every entry resolves to a row even on total network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("DNS resolution failed"));

    const results = await checkMcpVersions();
    expect(results.length).toBe(Object.keys(MCP_PINS).length);
    expect(results.every((r) => r.status === "fetch-failed")).toBe(true);
    expect(
      results.every((r) => r.error?.includes("DNS resolution failed")),
    ).toBe(true);
  });

  it("populates packageName and pinnedVersion correctly for every row", async () => {
    fetchSpy.mockRejectedValue(new Error("offline"));
    const results = await checkMcpVersions();
    for (const result of results) {
      expect(result.packageName).toContain(".");
      expect(result.pinnedVersion).toMatch(/^\d/);
      // Reassembling must match an entry in MCP_PINS exactly.
      const reassembled = `${result.packageName}@${result.pinnedVersion}`;
      expect(Object.values(MCP_PINS)).toContain(reassembled);
    }
  });
});

// ── Script helpers (used by apps/cli/scripts/check-mcp-versions.ts) ─────────

describe("formatScriptRow", () => {
  it("renders an up-to-date row with the ✓ glyph", () => {
    const row: McpVersionCheckResult = {
      packageName: "awslabs.aws-pricing-mcp-server",
      pinnedVersion: "1.0.27",
      latestVersion: "1.0.27",
      status: "up-to-date",
    };
    expect(formatScriptRow(row)).toMatch(/^✓/);
    expect(formatScriptRow(row)).toContain("up-to-date");
  });

  it("renders a behind row with the ! glyph and the latest version", () => {
    const row: McpVersionCheckResult = {
      packageName: "awslabs.aws-pricing-mcp-server",
      pinnedVersion: "1.0.27",
      latestVersion: "1.0.30",
      status: "behind",
    };
    const line = formatScriptRow(row);
    expect(line).toMatch(/^!/);
    expect(line).toContain("behind");
    expect(line).toContain("1.0.30");
  });

  it("renders a fetch-failed row with the ? glyph and the error", () => {
    const row: McpVersionCheckResult = {
      packageName: "awslabs.aws-pricing-mcp-server",
      pinnedVersion: "1.0.27",
      latestVersion: null,
      status: "fetch-failed",
      error: "DNS resolution failed",
    };
    const line = formatScriptRow(row);
    expect(line).toMatch(/^\?/);
    expect(line).toContain("DNS resolution failed");
  });
});

describe("computeScriptExitCode", () => {
  it("returns 0 when every row is up-to-date", () => {
    const result = computeScriptExitCode([
      {
        packageName: "a",
        pinnedVersion: "1.0.0",
        latestVersion: "1.0.0",
        status: "up-to-date",
      },
      {
        packageName: "b",
        pinnedVersion: "2.0.0",
        latestVersion: "2.0.0",
        status: "up-to-date",
      },
    ]);
    expect(result.code).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("returns 1 when ANY row is behind", () => {
    const result = computeScriptExitCode([
      {
        packageName: "a",
        pinnedVersion: "1.0.0",
        latestVersion: "1.0.0",
        status: "up-to-date",
      },
      {
        packageName: "b",
        pinnedVersion: "1.0.0",
        latestVersion: "1.0.5",
        status: "behind",
      },
    ]);
    expect(result.code).toBe(1);
  });

  it("returns 0 with a warning when EVERY row is fetch-failed (offline runner)", () => {
    const result = computeScriptExitCode([
      {
        packageName: "a",
        pinnedVersion: "1.0.0",
        latestVersion: null,
        status: "fetch-failed",
        error: "DNS",
      },
      {
        packageName: "b",
        pinnedVersion: "2.0.0",
        latestVersion: null,
        status: "fetch-failed",
        error: "DNS",
      },
    ]);
    expect(result.code).toBe(0);
    expect(result.warning).toContain("offline");
  });

  it("returns 0 (no warning) when SOME failed but others succeeded — partial outage is informative not blocking", () => {
    const result = computeScriptExitCode([
      {
        packageName: "a",
        pinnedVersion: "1.0.0",
        latestVersion: "1.0.0",
        status: "up-to-date",
      },
      {
        packageName: "b",
        pinnedVersion: "2.0.0",
        latestVersion: null,
        status: "fetch-failed",
        error: "timeout",
      },
    ]);
    expect(result.code).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("returns 0 for an empty result list (no MCPs to check is a vacuous success)", () => {
    expect(computeScriptExitCode([]).code).toBe(0);
  });
});

describe("runMcpVersionScript", () => {
  it("prints summary lines, returns 0, and never errors when all up-to-date", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpVersionScript(
      (line) => out.push(line),
      (line) => err.push(line),
      async () => [
        {
          packageName: "awslabs.aws-pricing-mcp-server",
          pinnedVersion: "1.0.27",
          latestVersion: "1.0.27",
          status: "up-to-date",
        },
      ],
    );
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("Summary:"))).toBe(true);
    expect(out.some((l) => l.includes("up-to-date"))).toBe(true);
    expect(err.length).toBe(0);
  });

  it("returns 1 and emits a fail-line on stderr when any pin is behind", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpVersionScript(
      (line) => out.push(line),
      (line) => err.push(line),
      async () => [
        {
          packageName: "awslabs.aws-pricing-mcp-server",
          pinnedVersion: "1.0.27",
          latestVersion: "1.0.30",
          status: "behind",
        },
      ],
    );
    expect(code).toBe(1);
    expect(err.some((l) => l.startsWith("fail:"))).toBe(true);
    expect(out.some((l) => l.includes("behind"))).toBe(true);
  });

  it("returns 0 and emits a warning on stderr when every fetch failed", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runMcpVersionScript(
      (line) => out.push(line),
      (line) => err.push(line),
      async () => [
        {
          packageName: "awslabs.aws-pricing-mcp-server",
          pinnedVersion: "1.0.27",
          latestVersion: null,
          status: "fetch-failed",
          error: "ENETUNREACH",
        },
      ],
    );
    expect(code).toBe(0);
    expect(err.some((l) => l.startsWith("warning:"))).toBe(true);
  });
});
