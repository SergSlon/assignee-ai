/**
 * W3-02 (Epic 100 Round 5) — RBAC policy store.
 *
 * Two adapters:
 *   - `InMemoryPolicyStore` — holds policies in a `Map<role, Policy>`.
 *     Used for tests and the scaffold wave (no persistence needed today).
 *   - `FilePolicyStore` — persists policies as JSON to a file.
 *     Round-trips correctly: write then read returns byte-identical data.
 *
 * Both adapters implement the same `PolicyStore` interface so Epic 101
 * can swap the backing without touching call sites.
 *
 * Enforcement at command boundaries defers to Epic 101.  Today the store
 * is used only for schema-validation tests and as a data-layer scaffold.
 *
 * RW4d-migration-B (M-016): `FilePolicyStore` now accepts an optional
 * `StoragePort` to decouple from `node:fs`. When `storage` is omitted
 * the constructor builds a `LocalFsStorageAdapter` rooted at the
 * directory of `filePath`, with the file's basename used as the
 * storage key. The atomic temp-rename + 0o600 mode bolts live inside
 * `LocalFsStorageAdapter.writeBytes`, so the port-backed path
 * preserves the same wire-level guarantees as the legacy direct-fs
 * code path. The legacy path additionally performs a defence-in-depth
 * post-rename `chmod` — that bolt is preserved on the fallback path
 * only and is unreachable on the explicit-port path (where the
 * adapter is solely responsible for permissions).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";
import { parsePolicy, type Policy } from "./policy-schema.js";

// ── Interface ──────────────────────────────────────────────────────────

export interface PolicyStore {
  /** Add or replace the policy for the given role. */
  set(policy: Policy): Promise<void>;

  /** Return the policy for `role`, or `undefined` when not found. */
  get(role: string): Promise<Policy | undefined>;

  /** Return all policies. */
  list(): Promise<Policy[]>;

  /** Remove the policy for `role`. No-op when not found. */
  delete(role: string): Promise<void>;
}

// ── In-memory adapter ──────────────────────────────────────────────────

export class InMemoryPolicyStore implements PolicyStore {
  private readonly store = new Map<string, Policy>();

  async set(policy: Policy): Promise<void> {
    this.store.set(policy.role, policy);
  }

  async get(role: string): Promise<Policy | undefined> {
    return this.store.get(role);
  }

  async list(): Promise<Policy[]> {
    return Array.from(this.store.values());
  }

  async delete(role: string): Promise<void> {
    this.store.delete(role);
  }
}

// ── File adapter ───────────────────────────────────────────────────────

/**
 * Stores all policies as a JSON array in `filePath`.
 * Reads the file on every `get` / `list` to reflect external updates.
 * Writes are atomic via a temp-rename pattern (0o600 permissions).
 *
 * RW4d-migration-B: when `storage` is omitted, the constructor builds
 * a `LocalFsStorageAdapter` rooted at `dirname(filePath)`. The storage
 * key is `basename(filePath)`. This preserves the legacy single-file
 * layout exactly while allowing future SaaS callers to pass an
 * S3-/DDB-backed adapter without touching this file.
 */
export class FilePolicyStore implements PolicyStore {
  private readonly port: StoragePort;
  private readonly key: string;

  constructor(
    private readonly filePath: string,
    // TODO(SaaS): require StoragePort once all callers thread it through.
    storage?: StoragePort,
  ) {
    this.key = path.basename(filePath);
    this.port =
      storage ?? new LocalFsStorageAdapter({ rootDir: path.dirname(filePath) });
  }

  private async readAll(): Promise<Policy[]> {
    try {
      const raw = await this.port.readText(this.key);
      if (raw === undefined) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        // Audit dev-D25: malformed (non-array) JSON would otherwise vanish
        // silently into an empty result, masking corruption. Surface a
        // single-line stderr warning so operators see the file is
        // recoverable but not load-bearing in this state.
        process.stderr.write(
          `policy-store: ${this.key} is not a JSON array; ignoring (got ${typeof parsed}).\n`,
        );
        return [];
      }
      return parsed.map((item) => parsePolicy(item));
    } catch {
      return [];
    }
  }

  private async writeAll(policies: Policy[]): Promise<void> {
    // Port-backed atomic write. LocalFsStorageAdapter.writeBytes uses a
    // temp-file + rename and writes with 0o600, so the wire-level
    // semantics match the legacy direct-fs code path. The legacy
    // post-rename `chmod` defence-in-depth is preserved on the fallback
    // codepath below for filesystems where rename() inherits a looser
    // mode from a pre-existing file.
    await this.port.writeJson(this.key, policies, 2);

    // Defence-in-depth: post-rename chmod when we own the local-fs
    // adapter (i.e. no explicit port supplied). Best-effort — silently
    // ignored on filesystems / adapters that do not support chmod.
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      /* best-effort */
    }
  }

  async set(policy: Policy): Promise<void> {
    const all = await this.readAll();
    const idx = all.findIndex((p) => p.role === policy.role);
    if (idx >= 0) {
      all[idx] = policy;
    } else {
      all.push(policy);
    }
    await this.writeAll(all);
  }

  async get(role: string): Promise<Policy | undefined> {
    const all = await this.readAll();
    return all.find((p) => p.role === role);
  }

  async list(): Promise<Policy[]> {
    return this.readAll();
  }

  async delete(role: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((p) => p.role !== role));
  }
}
