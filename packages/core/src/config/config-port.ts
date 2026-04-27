/**
 * ConfigPort — abstraction over environment-variable / configuration lookup.
 *
 * MASTER-009 (BLOCKER): direct `process.env` reads scattered through core
 * block multi-tenant SaaS deployments where each tenant must run with its
 * own configuration scope. This port lets every consumer take a
 * `ConfigPort` via dependency injection instead of reaching at the
 * process-global env. The default `ProcessEnvConfigAdapter` preserves
 * today's behaviour (read from `process.env`); SaaS callers can supply
 * tenant-scoped adapters (in-memory map, secrets-manager backed, etc.)
 * without changing call-sites.
 *
 * Hard invariants:
 *   - NO module-level singleton instance. The whole point of the port is
 *     dependency injection; a singleton would re-introduce the global
 *     state that MASTER-009 eliminates. Every caller MUST receive a
 *     ConfigPort by constructor / factory parameter.
 *   - Strict TS / TS4111 clean — adapters use bracket access on
 *     `process.env` so the strict-typed key signature compiles.
 *   - Per-instance cache only. Two ConfigPort instances do NOT share
 *     state, so tenant boundaries are leak-proof.
 *
 * @see _bmad-output/implementation-artifacts/master-009-process-env-removal.md
 */

/**
 * Read-only, typed configuration lookup. Accepts string keys (more
 * flexible than a closed enum) so callers can use either raw env-var
 * names or values from the {@link EnvVar} enum interchangeably.
 */
export interface ConfigPort {
  /**
   * Returns the configured value for `key`, or `defaultValue` if unset,
   * or `undefined` if neither is provided. Empty strings are treated
   * as "set" (matching `process.env` semantics — only literally
   * undefined / never-assigned keys are "unset").
   */
  get(key: string, defaultValue?: string): string | undefined;

  /**
   * Returns the configured value for `key`, throwing a descriptive
   * `Error` when no value is configured. Use for required configuration
   * (operator credentials, mandatory endpoints).
   */
  getRequired(key: string): string;

  /**
   * Returns the configured value parsed as a base-10 integer, or
   * `defaultValue` when unset / non-numeric, or `undefined` when neither
   * is provided. Non-numeric values trigger fallback to `defaultValue`
   * (matching the "lenient parse" pattern already used across the
   * codebase for ASSIGNEE_LOG_RETENTION_DAYS et al).
   */
  getInt(key: string, defaultValue?: number): number | undefined;

  /**
   * Returns the configured value parsed as a boolean. Truthy: `"1"`,
   * `"true"`, `"yes"`, `"on"` (case-insensitive). Falsy: `"0"`,
   * `"false"`, `"no"`, `"off"` (case-insensitive). Any other non-empty
   * value falls back to `defaultValue` and emits ONE `console.warn`
   * per key per instance (subsequent unparseable reads of the same key
   * are silent — avoids log floods in tight loops).
   */
  getBool(key: string, defaultValue?: boolean): boolean | undefined;
}

/**
 * Default `ConfigPort` implementation that reads from `process.env`.
 *
 * Use sparingly — prefer to construct ONE adapter at the composition
 * root (CLI bootstrap / MCP server entrypoint) and thread the resulting
 * port through the dependency graph. Constructing fresh adapters
 * inside library code defeats the abstraction (each instance has its
 * own cache, but they all read the same global `process.env`).
 *
 * Caching: every successful resolution is memoised PER-INSTANCE.
 * Mutations to `process.env` after first read are NOT observed by an
 * existing adapter — callers that need to react to runtime env-var
 * changes should construct a new adapter.
 */
export class ProcessEnvConfigAdapter implements ConfigPort {
  /** Per-instance cache of resolved raw string values. */
  private readonly cache = new Map<string, string | undefined>();

  /** Per-instance set of keys for which a parse-warning has fired. */
  private readonly warnedKeys = new Set<string>();

  get(key: string, defaultValue?: string): string | undefined {
    const raw = this.readRaw(key);
    if (raw !== undefined) {
      return raw;
    }
    return defaultValue;
  }

  getRequired(key: string): string {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      throw new Error(
        `Required configuration key "${key}" is not set. ` +
          `Set the ${key} environment variable or supply a ConfigPort ` +
          `that provides this value.`,
      );
    }
    return raw;
  }

  getInt(key: string, defaultValue?: number): number | undefined {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      return defaultValue;
    }
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      this.warnOnce(key, `non-numeric value "${raw}" for integer key`);
      return defaultValue;
    }
    return parsed;
  }

  getBool(key: string, defaultValue?: boolean): boolean | undefined {
    const raw = this.readRaw(key);
    if (raw === undefined) {
      return defaultValue;
    }
    const normalised = raw.trim().toLowerCase();
    if (
      normalised === "1" ||
      normalised === "true" ||
      normalised === "yes" ||
      normalised === "on"
    ) {
      return true;
    }
    if (
      normalised === "0" ||
      normalised === "false" ||
      normalised === "no" ||
      normalised === "off"
    ) {
      return false;
    }
    this.warnOnce(key, `unparseable boolean value "${raw}"`);
    return defaultValue;
  }

  /**
   * Reads `process.env[key]` once, then caches the result (including
   * `undefined`) on this instance. Bracket access keeps strict TS
   * (TS4111) happy — `process.env` is typed with an indexed signature
   * but TS4111 forbids dot access on indexed-signature members.
   */
  private readRaw(key: string): string | undefined {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const value = process.env[key];
    this.cache.set(key, value);
    return value;
  }

  /**
   * Emits exactly one `console.warn` per `(instance, key)` pair.
   * Subsequent unparseable reads of the same key on the same instance
   * are silent — keeps log volume bounded under tight loops while
   * still surfacing the misconfiguration once.
   */
  private warnOnce(key: string, detail: string): void {
    if (this.warnedKeys.has(key)) {
      return;
    }
    this.warnedKeys.add(key);
    // eslint-disable-next-line no-console
    console.warn(
      `[ConfigPort] ${detail} for key "${key}" — falling back to default.`,
    );
  }
}
