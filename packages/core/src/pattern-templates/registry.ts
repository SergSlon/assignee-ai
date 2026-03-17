import type { ArchitecturePattern } from "./types.js";

/**
 * Registry of ArchitecturePattern instances, keyed by patternId.
 * Plain class — not a singleton; default instance exported from `index.ts`.
 * Mirrors the PluginRegistry pattern from packages/core/src/resource-plugins/registry.ts.
 *
 * @example
 * const registry = new PatternRegistry()
 * registry.register(serverlessApiPattern)
 * const match = registry.detect('create a serverless api') // → serverlessApiPattern
 */
export class PatternRegistry {
  private readonly patterns = new Map<string, ArchitecturePattern>();

  /** Register a pattern. Overwrites if same patternId already registered. */
  register(pattern: ArchitecturePattern): void {
    this.patterns.set(pattern.patternId, pattern);
  }

  /**
   * Detect if userIntent matches a registered pattern.
   * Uses case-insensitive substring matching — NO Bedrock/LLM call.
   * Returns the first matching pattern in insertion order, or null if none match.
   * Zero latency cost when no pattern matches.
   */
  detect(userIntent: string): ArchitecturePattern | null {
    const normalized = userIntent.toLowerCase();
    for (const pattern of this.patterns.values()) {
      if (
        pattern.keywords.some((kw) => normalized.includes(kw.toLowerCase()))
      ) {
        return pattern;
      }
    }
    return null;
  }

  /** Retrieve a pattern by patternId. Returns undefined if not registered. */
  get(patternId: string): ArchitecturePattern | undefined {
    return this.patterns.get(patternId);
  }

  /** Check if a pattern is registered for the given patternId. */
  has(patternId: string): boolean {
    return this.patterns.has(patternId);
  }
}
