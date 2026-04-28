/**
 * LocalFsStorageAdapter — default StoragePort implementation backed by
 * `node:fs`. Mirrors today's filesystem-based persistence (atomic writes
 * via temp-file + rename, file mode 0600, dir mode 0700) so that the
 * existing call-sites can swap in the port without behavioural drift.
 *
 * Path-traversal hardening: keys must be relative (no leading `/`) and
 * must not contain `..` segments. Validation runs at the port boundary
 * (`validateKey`) — not deep in the filesystem layer — so a path-
 * traversal attempt is rejected before any `fs` call is made.
 *
 * @see ../../ports/storage-port.ts — port interface contract.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname, join, sep } from "node:path";

import type { StoragePort } from "../../ports/storage-port.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface LocalFsStorageAdapterOptions {
  /**
   * Root directory under which every key maps. Required (no default —
   * caller must supply, e.g. `~/.assignee/state`). The directory is
   * created on first write with mode 0700 if missing.
   */
  readonly rootDir: string;
}

export class LocalFsStorageAdapter implements StoragePort {
  private readonly rootDir: string;

  constructor(options: LocalFsStorageAdapterOptions) {
    this.rootDir = options.rootDir;
  }

  async has(key: string): Promise<boolean> {
    const path = this.resolveKey(key);
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async readBytes(key: string): Promise<Uint8Array | undefined> {
    const path = this.resolveKey(key);
    try {
      const buf = await fs.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isENOENT(err)) return undefined;
      throw err;
    }
  }

  async readText(key: string): Promise<string | undefined> {
    const bytes = await this.readBytes(key);
    if (bytes === undefined) return undefined;
    return new TextDecoder("utf-8").decode(bytes);
  }

  async readJson<T = unknown>(key: string): Promise<T | undefined> {
    const text = await this.readText(key);
    if (text === undefined) return undefined;
    return JSON.parse(text) as T;
  }

  async writeBytes(key: string, value: Uint8Array): Promise<void> {
    const path = this.resolveKey(key);
    await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, value, { mode: FILE_MODE });
    try {
      await fs.rename(tempPath, path);
    } catch (err) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw err;
    }
  }

  async writeText(key: string, value: string): Promise<void> {
    await this.writeBytes(key, new TextEncoder().encode(value));
  }

  async writeJson<T = unknown>(
    key: string,
    value: T,
    spaces: number = 0,
  ): Promise<void> {
    await this.writeText(key, JSON.stringify(value, null, spaces));
  }

  async delete(key: string): Promise<boolean> {
    const path = this.resolveKey(key);
    try {
      await fs.unlink(path);
      return true;
    } catch (err) {
      if (isENOENT(err)) return false;
      throw err;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    await this.collectKeys(this.rootDir, "", keys);
    const filtered = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    return filtered.sort();
  }

  async stat(key: string): Promise<{ lastModifiedMs: number } | undefined> {
    const path = this.resolveKey(key);
    try {
      const s = await fs.stat(path);
      return { lastModifiedMs: s.mtimeMs };
    } catch (err) {
      if (isENOENT(err)) return undefined;
      throw err;
    }
  }

  async tryAcquire(key: string, value: Uint8Array): Promise<boolean> {
    const path = this.resolveKey(key);
    await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    let fh: import("node:fs/promises").FileHandle | undefined;
    try {
      fh = await fs.open(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        FILE_MODE,
      );
    } catch (err) {
      if (isEEXIST(err)) return false;
      throw err;
    }
    try {
      if (value.byteLength > 0) await fh.write(value);
      return true;
    } catch (err) {
      // QA Q-002 / R4-002: post-O_EXCL write failure (ENOSPC, EROFS, EIO)
      // would otherwise orphan a 0-byte lock file that subsequent acquirers
      // see as a held lock. Unlink before rethrowing so the next acquirer
      // sees no-lock-held instead of false-positive-held.
      await fh.close().catch(() => undefined);
      fh = undefined;
      await fs.unlink(path).catch(() => undefined);
      throw err;
    } finally {
      if (fh) await fh.close();
    }
  }

  private async collectKeys(
    absDir: string,
    relPrefix: string,
    out: string[],
  ): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isENOENT(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.collectKeys(childAbs, childRel, out);
      } else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
        out.push(childRel);
      }
    }
  }

  private resolveKey(key: string): string {
    validateKey(key);
    return join(this.rootDir, key);
  }
}

function validateKey(key: string): void {
  if (key.length === 0) {
    throw new Error("StoragePort: key must be a non-empty string");
  }
  if (key.startsWith("/") || key.startsWith(sep)) {
    throw new Error(
      `StoragePort: key must be relative (no leading '/'); got '${key}'`,
    );
  }
  if (key.includes("\0")) {
    throw new Error(
      "StoragePort: key must not contain NUL bytes (path-injection guard)",
    );
  }
  // Split on both POSIX and platform separators so e.g. "a/../b" or
  // "a\..\b" is caught BEFORE node:path normalization collapses the
  // traversal segment.
  const segments = key.split(/[/\\]/);
  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(
        `StoragePort: key must not contain '..' path-traversal segments; got '${key}'`,
      );
    }
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ENOENT"
  );
}

function isEEXIST(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "EEXIST"
  );
}
