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
   *
   * A pattern is skipped (the scan continues) when its `negativeKeywords`
   * set has any case-insensitive substring hit on `userIntent`, even if
   * a positive keyword also matches. This lets bare "Create a VPC" and
   * "Create a standalone X" intents fall through to the LLM classifier
   * instead of short-circuiting into an expensive compound pattern.
   */
  detect(userIntent: string): ArchitecturePattern | null {
    const normalized = userIntent.toLowerCase();
    for (const pattern of this.patterns.values()) {
      const positiveHit = pattern.keywords.some((kw) =>
        normalized.includes(kw.toLowerCase()),
      );
      if (!positiveHit) continue;
      const negatives = pattern.negativeKeywords ?? [];
      const negativeHit = negatives.some((kw) =>
        normalized.includes(kw.toLowerCase()),
      );
      if (negativeHit) continue;
      return pattern;
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

  /** Number of registered patterns — used by doctor and status commands. */
  size(): number {
    return this.patterns.size;
  }

  /**
   * List all registered patterns in insertion (registration) order.
   * Used by `assignee patterns list` for discoverability. Insertion
   * order matters because pattern detection is first-match-wins on
   * keyword substring — the listing reflects the precedence.
   */
  list(): ArchitecturePattern[] {
    return Array.from(this.patterns.values());
  }
}
