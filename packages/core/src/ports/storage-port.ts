/**
 * RW4d (MASTER-016) — StoragePort: hexagonal port for key/value blob storage.
 *
 * Substrate for the SaaS migration: today every persistent state in core
 * (checkpoint store, RBAC policy store, advisory locks, user-config loader,
 * org-policy cache, durable adapters) reaches directly into `node:fs`.
 * Without an abstraction, replacing each call-site with HTTP/S3/DDB I/O
 * during the SaaS lift is a fresh refactor per file. With this port,
 * the call-site stays put and only the adapter swaps.
 *
 * Design principles:
 *
 *   - Keys are opaque strings owned by the adapter. The adapter translates
 *     them into concrete storage targets (file path under a root dir, S3
 *     object key, DynamoDB partition+sort, etc.). Callers must not assume
 *     any particular layout.
 *   - All read methods return `undefined` for missing keys (never throw
 *     ENOENT-style errors). This mirrors the "best-effort recovery"
 *     contract used by `CheckpointerPort.load` and lets callers treat a
 *     missing blob as a clean "no data yet" path.
 *   - `writeBytes` MUST be atomic — a concurrent reader must never see a
 *     partial write. The local-fs adapter implements this via temp-file +
 *     rename; remote adapters (S3 with conditional PUT, DDB transactional
 *     write) implement equivalent semantics.
 *   - `readJson` does NOT enforce a schema. Callers that need schema
 *     validation (Zod, etc.) must wrap the call themselves. Malformed
 *     JSON is the caller's responsibility — the port's job is to produce
 *     a parsed value or surface a parse error, not to police shape.
 *   - `list` returns sorted keys (alphabetical) for determinism. Adapters
 *     that wrap unordered storage (S3 ListObjectsV2 is alphabetical;
 *     DynamoDB Query needs an explicit sort) must sort before returning.
 *
 * Migration of the seven existing fs call-sites
 * (`checkpoint/{store,loader,pruner,auto-detect,file-durable-adapter}`,
 * `rbac/policy-store`, `locks/file-advisory-lock`, `config/user-config-loader`)
 * is OUT OF SCOPE for this wave. RW4d-migration in a follow-up will swap
 * each one to take a `StoragePort` via DI.
 *
 * @see packages/core/src/adapters/storage/local-fs-adapter.ts — default impl.
 */

/**
 * StoragePort — abstraction over key/value blob storage.
 *
 * Implementations must be:
 *   - Safe for concurrent reads (multiple `readBytes` may run in parallel).
 *   - Atomic for `writeBytes` (no partial-write visible to a concurrent
 *     reader; either the old value or the new value, never a mix).
 *   - Idempotent for `writeBytes` (overwriting an existing key is valid).
 *   - Idempotent for `delete` (deleting a non-existent key returns false,
 *     does not throw).
 */
export interface StoragePort {
  /** Existence check. Cheap — does not read the blob's content. */
  has(key: string): Promise<boolean>;

  /** Read raw bytes. Returns `undefined` for missing keys. */
  readBytes(key: string): Promise<Uint8Array | undefined>;

  /** Read UTF-8 text. Convenience wrapper over `readBytes`. */
  readText(key: string): Promise<string | undefined>;

  /**
   * Read parsed JSON. Returns `undefined` for missing keys. Throws on
   * malformed JSON — callers that need a soft-fail path must wrap the
   * call themselves. `T` is caller-supplied; the port performs no schema
   * validation.
   */
  readJson<T = unknown>(key: string): Promise<T | undefined>;

  /** Write raw bytes atomically (no partial-write visible). */
  writeBytes(key: string, value: Uint8Array): Promise<void>;

  /** Write UTF-8 text atomically. Convenience wrapper over `writeBytes`. */
  writeText(key: string, value: string): Promise<void>;

  /**
   * Write JSON-stringified value atomically. `spaces` is forwarded to
   * `JSON.stringify` for pretty-printing (default: 0 = no whitespace).
   */
  writeJson<T = unknown>(key: string, value: T, spaces?: number): Promise<void>;

  /**
   * Delete a key. Returns `true` when the key existed and was removed,
   * `false` when the key did not exist. Never throws for missing keys.
   */
  delete(key: string): Promise<boolean>;

  /**
   * List keys matching `prefix` (or all keys when `prefix` is omitted).
   * Returns alphabetically-sorted keys for determinism across adapters.
   */
  list(prefix?: string): Promise<string[]>;
}
