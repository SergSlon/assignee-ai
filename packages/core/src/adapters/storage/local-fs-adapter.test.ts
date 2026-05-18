/**
 * Tests for LocalFsStorageAdapter (RW4d / MASTER-016).
 *
 * Pinned focus: contract conformance with StoragePort + path-traversal
 * rejection at the port boundary + atomic-write guarantee.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { LocalFsStorageAdapter } from "./local-fs-adapter.js";

let workspace: string;
let adapter: LocalFsStorageAdapter;

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), "storage-port-test-"));
  adapter = new LocalFsStorageAdapter({ rootDir: workspace });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("LocalFsStorageAdapter — has", () => {
  it("returns false for a missing key", async () => {
    expect(await adapter.has("missing")).toBe(false);
  });

  it("returns true after writeBytes", async () => {
    await adapter.writeBytes("k", new Uint8Array([1, 2, 3]));
    expect(await adapter.has("k")).toBe(true);
  });
});

describe("LocalFsStorageAdapter — readBytes / writeBytes", () => {
  it("readBytes returns undefined for a missing key", async () => {
    expect(await adapter.readBytes("missing")).toBeUndefined();
  });

  it("round-trips a Uint8Array", async () => {
    const value = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await adapter.writeBytes("blob", value);
    const got = await adapter.readBytes("blob");
    expect(got).toEqual(value);
  });

  it("creates intermediate directories on write", async () => {
    await adapter.writeBytes("nested/path/file", new Uint8Array([42]));
    const got = await adapter.readBytes("nested/path/file");
    expect(got).toEqual(new Uint8Array([42]));
  });
});

describe("LocalFsStorageAdapter — readText / writeText", () => {
  it("round-trips a UTF-8 string", async () => {
    await adapter.writeText("greeting", "héllo wörld 🌍");
    expect(await adapter.readText("greeting")).toBe("héllo wörld 🌍");
  });

  it("readText returns undefined for missing", async () => {
    expect(await adapter.readText("missing")).toBeUndefined();
  });
});

describe("LocalFsStorageAdapter — readJson / writeJson", () => {
  it("round-trips a typed object", async () => {
    interface Pinned {
      readonly id: number;
      readonly name: string;
    }
    const value: Pinned = { id: 42, name: "tenant-a" };
    await adapter.writeJson<Pinned>("obj", value);
    const got = await adapter.readJson<Pinned>("obj");
    expect(got).toEqual(value);
  });

  it("readJson returns undefined for missing key", async () => {
    expect(await adapter.readJson("missing")).toBeUndefined();
  });

  it("readJson throws on malformed JSON (port does not soft-fail parse)", async () => {
    await adapter.writeText("malformed", "{ not: valid json");
    await expect(adapter.readJson("malformed")).rejects.toThrow();
  });

  it("writeJson honors the spaces argument for pretty printing", async () => {
    await adapter.writeJson("pretty", { a: 1 }, 2);
    const got = await adapter.readText("pretty");
    expect(got).toBe('{\n  "a": 1\n}');
  });
});

describe("LocalFsStorageAdapter — delete", () => {
  it("returns true after deleting an existing key", async () => {
    await adapter.writeText("k", "v");
    expect(await adapter.delete("k")).toBe(true);
    expect(await adapter.has("k")).toBe(false);
  });

  it("returns false for a missing key (does not throw)", async () => {
    expect(await adapter.delete("missing")).toBe(false);
  });
});

describe("LocalFsStorageAdapter — list", () => {
  it("returns an empty array for an empty store", async () => {
    expect(await adapter.list()).toEqual([]);
  });

  it("returns sorted keys", async () => {
    await adapter.writeText("c", "3");
    await adapter.writeText("a", "1");
    await adapter.writeText("b", "2");
    expect(await adapter.list()).toEqual(["a", "b", "c"]);
  });

  it("filters by prefix", async () => {
    await adapter.writeText("tenants/a/state", "1");
    await adapter.writeText("tenants/b/state", "2");
    await adapter.writeText("global", "x");
    expect(await adapter.list("tenants/")).toEqual([
      "tenants/a/state",
      "tenants/b/state",
    ]);
  });

  it("excludes .tmp orphans (atomic-write artefacts)", async () => {
    await adapter.writeText("k", "v");
    // Simulate a .tmp orphan from a crashed write.
    await fs.writeFile(join(workspace, "stale.tmp"), "ignored");
    expect(await adapter.list()).toEqual(["k"]);
  });
});

describe("LocalFsStorageAdapter — validateKey (path-traversal hardening)", () => {
  it("rejects an absolute path", async () => {
    await expect(adapter.writeText("/absolute/path", "x")).rejects.toThrow(
      /leading '\/'/,
    );
  });

  it("rejects a key with .. traversal segments", async () => {
    await expect(adapter.writeText("a/../b", "x")).rejects.toThrow(
      /path-traversal/,
    );
  });

  it("rejects a key starting with ..", async () => {
    await expect(adapter.writeText("../escape", "x")).rejects.toThrow(
      /path-traversal/,
    );
  });

  it("rejects a key containing a NUL byte", async () => {
    await expect(adapter.writeText("nul\0byte", "x")).rejects.toThrow(/NUL/);
  });

  it("rejects an empty key", async () => {
    await expect(adapter.writeText("", "x")).rejects.toThrow(/non-empty/);
  });

  it("accepts a valid nested key", async () => {
    await expect(
      adapter.writeText("valid/nested/key", "x"),
    ).resolves.toBeUndefined();
  });
});

describe("LocalFsStorageAdapter — file mode (0600 / 0700)", () => {
  it("creates files with mode 0600", async () => {
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    await adapter.writeText("k", "v");
    const stat = await fs.stat(join(workspace, "k"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates directories with mode 0700", async () => {
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    await adapter.writeText("nested/file", "v");
    const stat = await fs.stat(join(workspace, "nested"));
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

describe("LocalFsStorageAdapter — atomic write", () => {
  it("does not leave .tmp file on a successful write", async () => {
    await adapter.writeText("k", "v");
    const dirEntries = await fs.readdir(workspace);
    const tmpFiles = dirEntries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});

describe("LocalFsStorageAdapter — stat", () => {
  it("returns undefined for a missing key", async () => {
    expect(await adapter.stat("missing")).toBeUndefined();
  });

  it("returns lastModifiedMs after writeBytes", async () => {
    const before = Date.now();
    await adapter.writeText("k", "v");
    const result = await adapter.stat("k");
    expect(result).toBeDefined();
    expect(result!.lastModifiedMs).toBeGreaterThanOrEqual(before - 50);
    expect(result!.lastModifiedMs).toBeLessThanOrEqual(Date.now() + 50);
  });

  it("rejects a key containing a NUL byte", async () => {
    await expect(adapter.stat("nul\0byte")).rejects.toThrow(/NUL/);
  });

  it("returns undefined after delete", async () => {
    await adapter.writeText("k", "v");
    expect(await adapter.stat("k")).toBeDefined();
    await adapter.delete("k");
    expect(await adapter.stat("k")).toBeUndefined();
  });
});

describe("LocalFsStorageAdapter — tryAcquire", () => {
  it("returns true and creates the key when absent", async () => {
    const result = await adapter.tryAcquire(
      "lock",
      new TextEncoder().encode("pid-1"),
    );
    expect(result).toBe(true);
    expect(await adapter.readText("lock")).toBe("pid-1");
  });

  it("returns false when the key already exists", async () => {
    await adapter.tryAcquire("lock", new TextEncoder().encode("pid-1"));
    const result = await adapter.tryAcquire(
      "lock",
      new TextEncoder().encode("pid-2"),
    );
    expect(result).toBe(false);
    expect(await adapter.readText("lock")).toBe("pid-1");
  });

  it("is atomic under concurrent calls — exactly one winner", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        adapter.tryAcquire("race", new TextEncoder().encode(`pid-${i}`)),
      ),
    );
    const winners = attempts.filter((r) => r === true);
    expect(winners.length).toBe(1);
  });

  it("creates files with mode 0600", async () => {
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    await adapter.tryAcquire("locked", new TextEncoder().encode("x"));
    const stat = await fs.stat(join(workspace, "locked"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates parent directories on demand with mode 0700", async () => {
    await adapter.tryAcquire(
      "nested/dir/locked",
      new TextEncoder().encode("x"),
    );
    if (process.platform === "win32") return; // NTFS chmod is a no-op
    const stat = await fs.stat(join(workspace, "nested"));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("accepts an empty value (lock without payload)", async () => {
    const result = await adapter.tryAcquire("empty", new Uint8Array(0));
    expect(result).toBe(true);
    expect(await adapter.readText("empty")).toBe("");
  });

  it("rejects a key containing path traversal", async () => {
    await expect(
      adapter.tryAcquire("../escape", new Uint8Array(0)),
    ).rejects.toThrow(/\.\./);
  });

  it("preserves existing value when called twice", async () => {
    await adapter.tryAcquire("k", new TextEncoder().encode("first"));
    expect(
      await adapter.tryAcquire("k", new TextEncoder().encode("second")),
    ).toBe(false);
    expect(await adapter.readText("k")).toBe("first");
  });
});
