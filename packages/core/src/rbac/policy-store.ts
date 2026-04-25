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
 */

import * as fs from "node:fs/promises";
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
 */
export class FilePolicyStore implements PolicyStore {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Policy[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => parsePolicy(item));
    } catch {
      return [];
    }
  }

  private async writeAll(policies: Policy[]): Promise<void> {
    const { randomBytes } = await import("node:crypto");
    const tmpPath = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    const content = JSON.stringify(policies, null, 2);
    await fs.writeFile(tmpPath, content, { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);
    await fs.chmod(this.filePath, 0o600).catch(() => {});
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
